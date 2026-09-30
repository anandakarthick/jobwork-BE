import fs from 'fs/promises';
import { prisma } from '../../lib/prisma';
import { HttpError } from '../../lib/http-error';
import { getLlmProvider } from '../../lib/llm';
import { extractPages } from '../../lib/pdf/extract-rows';
import { extractItemsWithAI } from './price-list.ai';
import { countMatrixRows, parsePriceList, type ParsedItem } from './price-list.parser';

/**
 * Brand → parser. The generic coordinate parser handles any brand's catalogue
 * whose tables follow the common "catalog number + price" layout. Register a
 * brand-specific override here only if a supplier's PDF needs special handling.
 */
const BRAND_PARSERS: Record<string, typeof parsePriceList> = {
  // e.g. SIEMENS: parseSiemensPriceList,
};

function parserForBrand(brand: string) {
  return BRAND_PARSERS[brand.trim().toUpperCase()] ?? parsePriceList;
}

/**
 * Parse a price-list PDF on disk into structured items WITHOUT touching the
 * database. Used by the ingest flow and by the validation script. Works for
 * any brand — falls back to the generic parser when there's no override.
 */
export async function parsePriceListFileWithMeta(
  filePath: string,
  brand: string,
): Promise<{ items: ParsedItem[]; pageCount: number; matrixRows: number }> {
  const parse = parserForBrand(brand);
  const data = new Uint8Array(await fs.readFile(filePath));
  const pages = await extractPages(data);
  return { items: parse(pages), pageCount: pages.length, matrixRows: countMatrixRows(pages) };
}

export async function parsePriceListFile(filePath: string, brand: string): Promise<ParsedItem[]> {
  return (await parsePriceListFileWithMeta(filePath, brand)).items;
}

/**
 * A deterministic parse is "weak" when it clearly didn't fit the document's
 * format: no rows at all, far too few for the page count (a graphical /
 * non-tabular list), or a large share of matrix rows — one catalog number with a
 * price per variant column, which the parser can only read as its first price
 * (the signaling catalogue: colour × voltage tables). Weak parses fall back to
 * the LLM, which expands every column into its own row.
 */
const MATRIX_SHARE = 0.2;
function isWeakParse(itemCount: number, pageCount: number, matrixRows = 0): boolean {
  if (itemCount === 0) return true;
  if (pageCount >= 8 && itemCount < pageCount * 0.5) return true;
  return matrixRows > itemCount * MATRIX_SHARE;
}

const isPdf = (mime: string, name: string) => /pdf$/i.test(mime) || /\.pdf$/i.test(name);

/**
 * Reconcile the LLM's extracted items with the deterministic parser's items
 * (both keyed by catalog number). The LLM is the primary extractor (works on
 * any format, good recall); the parser is the structural authority:
 *   - Type: always taken from the parser when it has one (its rating-range/frame
 *     logic is immune to the merged-cell mis-typing the LLM can produce), and
 *     breaking-kA is re-derived to stay consistent with the corrected Type.
 *   - poles / rating fields: filled from the parser when the LLM left them null.
 *   - Rows the LLM missed but the parser found are added (union).
 */
export function reconcileWithParser(llm: ParsedItem[], parser: ParsedItem[]): ParsedItem[] {
  const key = (c: string) => c.trim().toUpperCase();
  const out = new Map<string, ParsedItem>();
  for (const it of llm) out.set(key(it.catalogNo), { ...it });

  const pMap = new Map(parser.map((it) => [key(it.catalogNo), it]));
  for (const [cat, it] of out) {
    const pr = pMap.get(cat);
    if (!pr) continue;
    if (pr.type) {
      it.type = pr.type; // parser Type is the verified one
      if (pr.breakingKa != null) it.breakingKa = pr.breakingKa;
    }
    if (it.poles == null && pr.poles != null) it.poles = pr.poles;
    if (it.ratingAmp == null && pr.ratingAmp != null) it.ratingAmp = pr.ratingAmp;
    if (it.ratingAmpMin == null && pr.ratingAmpMin != null) it.ratingAmpMin = pr.ratingAmpMin;
    if (it.ratingAmpMax == null && pr.ratingAmpMax != null) it.ratingAmpMax = pr.ratingAmpMax;
  }
  // Add parser-only catalogs the LLM missed.
  for (const [cat, pr] of pMap) if (!out.has(cat)) out.set(cat, pr);
  return [...out.values()];
}

/**
 * Ingest a PRICE_LIST document into its price_list_items. Works for any format
 * — PDF, image (scan/photo), Word (.docx), or Excel/CSV — by reading it with
 * the configured AI provider and storing the structured rows it returns. When
 * no AI provider is configured, falls back to the deterministic PDF parser (so
 * text PDFs still ingest at zero cost). Idempotent — re-running replaces rows.
 */
export async function ingestDocument(documentId: number) {
  const doc = await prisma.productDocument.findUnique({ where: { id: documentId } });
  if (!doc) throw HttpError.notFound('Document not found');
  if (doc.kind !== 'PRICE_LIST')
    throw HttpError.badRequest('Document is not marked as a price list');
  if (!doc.brand) throw HttpError.badRequest('Price-list document has no brand set');

  await prisma.productDocument.update({
    where: { id: documentId },
    data: { ingestStatus: 'PROCESSING', ingestError: null },
  });

  // Run the (possibly multi-minute, chunked) extraction in the background so the
  // HTTP request returns immediately. The client polls ingestStatus for the result.
  void runIngestJob(documentId).catch(() => {
    /* runIngestJob records its own FAILED state */
  });

  return { documentId, status: 'PROCESSING' as const };
}

/** The actual extract → store work. Updates ingestStatus to COMPLETED/FAILED. */
async function runIngestJob(documentId: number) {
  const doc = await prisma.productDocument.findUnique({ where: { id: documentId } });
  if (!doc || !doc.brand) return;

  try {
    const provider = await getLlmProvider();
    const src = { fileName: doc.fileName, mimeType: doc.mimeType, path: doc.storagePath };
    const pdf = isPdf(doc.mimeType, doc.fileName);
    let items: ParsedItem[];

    if (pdf) {
      // TEXT PDF → deterministic parser first: instant, free, and accurate for
      // the tuned tabular format. Its rating-range Type logic handles merged
      // cells correctly and avoids pushing thousands of rows through the LLM.
      const { items: parsed, pageCount, matrixRows } = await parsePriceListFileWithMeta(
        doc.storagePath,
        doc.brand,
      );
      if (isWeakParse(parsed.length, pageCount, matrixRows)) {
        // The parser didn't fit this format (scan / matrix / graphical list) —
        // fall back to the LLM, which handles any layout.
        if (provider.name === 'stub') {
          // No AI configured: keep whatever the parser got (better than nothing)
          // if it found any rows; otherwise there is genuinely nothing to store.
          if (parsed.length === 0) {
            throw HttpError.badRequest(
              "Couldn't read a price table from this PDF. If it's a scan or a matrix-" +
                'style list, add an OpenAI or Claude API key (Settings → API Keys) and re-ingest.',
            );
          }
          items = parsed;
        } else {
          const aiItems = await extractItemsWithAI(provider, src, doc.brand);
          // Keep whichever recovered more rows (never regress a good parse).
          items = aiItems.length >= parsed.length ? aiItems : parsed;
        }
      } else {
        items = parsed;
      }
    } else {
      // Image / Word / Excel / CSV → needs the LLM.
      if (provider.name === 'stub') {
        throw HttpError.badRequest(
          'Add an OpenAI or Claude API key in Settings → API Keys to ingest ' +
            'image, Word, or Excel price lists. (Without AI, only text PDFs are supported.)',
        );
      }
      items = await extractItemsWithAI(provider, src, doc.brand);
    }

    await prisma.$transaction([
      prisma.priceListItem.deleteMany({ where: { documentId } }),
      prisma.priceListItem.createMany({
        data: items.map((it) => ({
          documentId,
          categoryId: doc.categoryId,
          brand: doc.brand!,
          family: it.family,
          type: it.type,
          catalogNo: it.catalogNo,
          description: it.description,
          poles: it.poles,
          ratingAmp: it.ratingAmp,
          ratingAmpMin: it.ratingAmpMin,
          ratingAmpMax: it.ratingAmpMax,
          breakingKa: it.breakingKa,
          listPrice: it.listPrice,
          unit: it.unit ?? null,
          pageNo: it.pageNo,
          rawText: it.rawText,
          attributes: (it.attributes ?? undefined) as object | undefined,
        })),
      }),
      prisma.productDocument.update({
        where: { id: documentId },
        data: {
          ingestStatus: 'COMPLETED',
          ingestedItemCount: items.length,
          ingestedAt: new Date(),
          ingestError: null,
        },
      }),
    ]);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Ingestion failed';
    await prisma.productDocument.update({
      where: { id: documentId },
      data: { ingestStatus: 'FAILED', ingestError: message.slice(0, 2000) },
    });
  }
}

/**
 * Ingest jobs run inside this process, so a restart loses any that were in
 * flight. Called at boot: mark those as failed so the file can be retrained
 * (saving the brand again, or "Train again") instead of showing "training…"
 * forever.
 */
export async function failInterruptedIngestJobs(): Promise<void> {
  await prisma.productDocument.updateMany({
    where: { ingestStatus: 'PROCESSING' },
    data: {
      ingestStatus: 'FAILED',
      ingestError: 'Interrupted by a server restart — save the brand again (or Train again) to retry.',
    },
  });
}

/** Mark a document as a price list for a given brand (prerequisite to ingest). */
export async function setDocumentKind(
  documentId: number,
  input: { kind: 'PRICE_LIST' | 'SPEC' | 'DRAWING' | 'OTHER'; brand?: string | null },
) {
  const doc = await prisma.productDocument.findUnique({ where: { id: documentId } });
  if (!doc) throw HttpError.notFound('Document not found');
  if (input.kind === 'PRICE_LIST' && !input.brand)
    throw HttpError.badRequest('A price-list document requires a brand');

  return prisma.productDocument.update({
    where: { id: documentId },
    data: {
      kind: input.kind,
      brand: input.kind === 'PRICE_LIST' ? input.brand : null,
      // Re-marking resets any prior ingestion state.
      ingestStatus: 'NOT_STARTED',
      ingestError: null,
      ingestedItemCount: null,
      ingestedAt: null,
    },
    select: { id: true, kind: true, brand: true, ingestStatus: true },
  });
}

/**
 * List every price-list document's ingest status (across all categories). The
 * frontend polls this so an in-flight ingest keeps updating — and can be
 * notified on completion/failure — even after the user navigates away or
 * refreshes, since the status lives in the DB, not in a page's memory.
 */
export async function listIngestJobs() {
  return prisma.productDocument.findMany({
    where: { kind: 'PRICE_LIST' },
    orderBy: { id: 'asc' },
    select: {
      id: true,
      categoryId: true,
      fileName: true,
      brand: true,
      ingestStatus: true,
      ingestedItemCount: true,
      ingestError: true,
      ingestedAt: true,
      textStatus: true,
      textChars: true,
      textSource: true,
      textError: true,
    },
  });
}

/** List parsed items for a price-list document (paginated). */
export async function listItems(
  documentId: number,
  query: { page: number; limit: number; search?: string },
) {
  const where = {
    documentId,
    ...(query.search
      ? {
          OR: [
            { catalogNo: { contains: query.search } },
            { description: { contains: query.search } },
          ],
        }
      : {}),
  };
  const [data, total] = await Promise.all([
    prisma.priceListItem.findMany({
      where,
      orderBy: { id: 'asc' },
      skip: (query.page - 1) * query.limit,
      take: query.limit,
    }),
    prisma.priceListItem.count({ where }),
  ]);
  return {
    data,
    meta: {
      page: query.page,
      limit: query.limit,
      total,
      totalPages: Math.max(1, Math.ceil(total / query.limit)),
    },
  };
}
