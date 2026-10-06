import { Prisma, type PriceListItem } from '@prisma/client';
import { prisma } from '../../lib/prisma';
import { rankCandidates } from '../price-list/price-list.retrieval';
import { HttpError } from '../../lib/http-error';
import { getEffectiveLlmConfig, getLlmProvider, type LlmMessage } from '../../lib/llm';
import { chatWithKnowledge, generateWithKnowledge, type KnowledgeResult } from './quote.knowledge';
import { knowledgeRulesForQuote } from '../companies/knowledge.service';
import { friendlyErrorMessage } from '../../lib/llm/errors';
import { readInputs, type InputFile } from './quote.reader';
import {
  applyRuleAccessories,
  consolidateLines,
  deriveSeries,
  extractRequirements,
  matchRequirements,
  priceLines,
  retrieveCandidates,
} from './quote.pipeline';
import { getTrainedPromptText, listPromptsForBrands } from '../companies/company.service';
import { retrieveReferenceSnippets } from '../price-list/price-list.text';
import { buildQuoteWorkbook } from './quote.xlsx';
import { buildBomWorkbook, groupIntoBom, type BomBoard, type BomFeeder, type BomItem } from './quote.bom';
import { clearProgress, getProgress, setProgress, type ProgressStage } from './quote.progress';
import type { CreateQuoteInput, ListQuotesQuery, UpdateQuoteInput } from './quote.schema';

/** Metadata for a stored upload, as produced by the multer middleware. */
export interface StoredFile {
  originalName: string;
  storedName: string;
  mimeType: string;
  sizeBytes: number;
  path: string;
}

const detailInclude = {
  customer: { select: { id: true, name: true } },
  category: { select: { id: true, name: true, brands: true } },
  documents: { orderBy: { id: 'asc' } },
  lines: { orderBy: { lineNo: 'asc' } },
  messages: { orderBy: { createdAt: 'asc' } },
} satisfies Prisma.QuoteInclude;

/** The rule ids stored on a quote, or null when it uses every trained prompt. */
function quotePromptIds(quote: { promptIds: Prisma.JsonValue | null }): number[] | null {
  return Array.isArray(quote.promptIds)
    ? quote.promptIds.filter((v): v is number => typeof v === 'number')
    : null;
}

/** A quote with its chosen rules resolved to names, for the chat header. */
export async function getQuote(id: number) {
  const quote = await prisma.quote.findUniqueOrThrow({ where: { id }, include: detailInclude });
  const ids = quotePromptIds(quote);
  const rules = ids
    ? await prisma.brandPrompt.findMany({
        where: { id: { in: ids } },
        select: { id: true, name: true, company: { select: { name: true } } },
        orderBy: { id: 'asc' },
      })
    : [];
  return {
    ...quote,
    rules: rules.map((r) => ({ id: r.id, name: r.name, brand: r.company.name })),
  };
}

export async function listQuotes(query: ListQuotesQuery) {
  const where: Prisma.QuoteWhereInput = query.customerId ? { customerId: query.customerId } : {};
  const [rows, total] = await Promise.all([
    prisma.quote.findMany({
      where,
      include: {
        customer: { select: { id: true, name: true } },
        category: { select: { id: true, name: true } },
        _count: { select: { lines: true } },
      },
      orderBy: { createdAt: 'desc' },
      skip: (query.page - 1) * query.limit,
      take: query.limit,
    }),
    prisma.quote.count({ where }),
  ]);
  return {
    data: rows,
    meta: {
      page: query.page,
      limit: query.limit,
      total,
      totalPages: Math.max(1, Math.ceil(total / query.limit)),
    },
  };
}

/** The `brand` field carries one or more brands, comma-separated (multi-select). */
function parseBrands(brand?: string | null): string[] {
  if (!brand) return [];
  return [...new Set(brand.split(',').map((b) => b.trim()).filter(Boolean))];
}

/**
 * Resolve the ingested price-list document(s) to match against. Price lists are
 * brand-owned and a brand can hold SEVERAL (e.g. a switchgear list + a signaling
 * list), so we take EVERY completed price-list document for each selected brand
 * and merge their pools — a BOQ can then match parts spread across a brand's
 * different catalogues, and a multi-brand selection draws from all of them.
 */
async function resolvePriceListDocumentIds(input: CreateQuoteInput): Promise<number[]> {
  if (input.priceListDocumentId) return [input.priceListDocumentId];
  const ids: number[] = [];
  for (const brand of parseBrands(input.brand)) {
    const docs = await prisma.productDocument.findMany({
      where: { brand, kind: 'PRICE_LIST', train: true, ingestStatus: 'COMPLETED' },
      orderBy: { id: 'desc' },
      select: { id: true },
    });
    ids.push(...docs.map((d) => d.id));
  }
  return [...new Set(ids)];
}

/** Auto-name a chat from its customer and BOQ file, e.g. "Acme — Panel BOQ". */
function autoTitle(customer: string, files: StoredFile[]): string {
  const file = files[0]?.originalName.replace(/\.[^.]+$/, '').trim();
  return `${customer}${file ? ` — ${file}` : ''}`.slice(0, 190);
}

/**
 * Change a chat's name, customer, brands or selected rules. The new brands and
 * rules apply to every later message and to the next regeneration; the lines
 * already generated are left as they are until the user regenerates.
 */
export async function updateQuote(id: number, input: UpdateQuoteInput) {
  if (input.customerId !== undefined) {
    const customer = await prisma.customer.findUnique({ where: { id: input.customerId } });
    if (!customer) throw HttpError.badRequest('Customer not found');
  }
  await prisma.quote.update({
    where: { id },
    data: {
      ...(input.title !== undefined ? { title: input.title } : {}),
      ...(input.customerId !== undefined ? { customerId: input.customerId } : {}),
      ...(input.brand !== undefined ? { brand: input.brand } : {}),
      ...(input.promptIds !== undefined ? { promptIds: input.promptIds } : {}),
    },
  });
  return getQuote(id);
}

export async function createQuote(input: CreateQuoteInput, files: StoredFile[], userId: number) {
  const customer = await prisma.customer.findUnique({ where: { id: input.customerId } });
  if (!customer) throw HttpError.badRequest('Customer not found');
  if (files.length === 0) throw HttpError.badRequest('Upload at least one input document');

  const priceListDocumentId = (await resolvePriceListDocumentIds(input))[0] ?? null;

  const quote = await prisma.quote.create({
    data: {
      title: input.title || autoTitle(customer.name, files),
      status: 'PROCESSING',
      promptIds: input.promptIds ?? undefined,
      customerId: input.customerId,
      categoryId: input.categoryId ?? null,
      brand: input.brand ?? null,
      priceListDocumentId,
      createdById: userId,
      documents: {
        create: files.map((f) => ({
          fileName: f.originalName,
          storedName: f.storedName,
          mimeType: f.mimeType,
          sizeBytes: f.sizeBytes,
          storagePath: f.path,
        })),
      },
    },
  });

  // The thread opens with what the user sent along with the BOQ.
  await prisma.quoteMessage.create({
    data: {
      quoteId: quote.id,
      role: 'USER',
      content: input.message || `Please prepare a quote from ${files.map((f) => f.originalName).join(', ')}.`,
      attachments: files.map((f) => ({
        name: f.originalName,
        path: f.path,
        mimeType: f.mimeType,
      })) as unknown as Prisma.InputJsonValue,
    },
  });

  // Generation runs in the background: the client gets the PROCESSING quote at
  // once and polls GET /quotes/:id/progress for the stage that is really running.
  setProgress(quote.id, 'collect', 'Loading price lists, rules and reference text');
  void processQuote(quote.id, input, files).catch(() => {
    /* processQuote records its own FAILED state */
  });
  return getQuote(quote.id);
}

/** Live generation progress plus the quote's status, for the client to poll. */
export async function getQuoteProgress(id: number) {
  const quote = await prisma.quote.findUnique({
    where: { id },
    select: { id: true, status: true, error: true },
  });
  if (!quote) throw HttpError.notFound('Quote not found');
  return { status: quote.status, error: quote.error, progress: getProgress(id) };
}

/**
 * The extract → retrieve → match → price → group pipeline, factored out so both
 * initial generation (processQuote) and chat-driven regeneration (when the user
 * attaches a different BOQ, or asks to target/limit a series) run identically.
 */
async function runQuotePipeline(opts: {
  provider: Awaited<ReturnType<typeof getLlmProvider>>;
  inputText: string;
  brandLabel: string;
  categoryName: string;
  defaultDiscountPct: number;
  /** What the customer typed with the BOQ — steers extraction and matching. */
  customerNotes: string;
  /** The brand rules (keyword prompts) picked for the chat — steer extraction and matching. */
  brandNotes: string;
  /** The quoted brands, for the reference-file lookup during matching. */
  brands: string[];
  pool: PriceListItem[];
  /** Reports the stage that is running, for the live progress card. */
  onProgress?: (stage: ProgressStage, detail?: string | null, fraction?: number) => void;
}) {
  const { provider, inputText, brandLabel, categoryName, defaultDiscountPct, customerNotes, brandNotes, brands, pool } = opts;
  const report = opts.onProgress ?? (() => undefined);
  report('extract', `Reading ${Math.max(1, Math.round(inputText.length / 1000))}k characters of BOQ text`);
  const extracted = await extractRequirements(
    provider,
    inputText,
    { brand: brandLabel, category: categoryName },
    [
      customerNotes && `CUSTOMER INSTRUCTIONS:\n${customerNotes}`,
      brandNotes && `BRAND RULES:\n${brandNotes}`,
    ]
      .filter(Boolean)
      .join('\n\n'),
  );
  // The brand rules decide the accessories (mandatory + conditional) per breaker.
  report('extract', `${extracted.length} line(s) found — applying the brand rules for accessories`, 0.7);
  const requirements = await applyRuleAccessories(provider, extracted, { brandNotes, customerNotes });
  report('retrieve', `${requirements.length} line(s) found — shortlisting ${pool.length} price-list rows`);
  const candidates = retrieveCandidates(pool, requirements);
  const series = deriveSeries(candidates, requirements);
  const matches = await matchRequirements(provider, requirements, candidates, series, {
    brandNotes,
    customerNotes,
    // Passages of the brands' reference files about the lines in each batch.
    retrieveReference: (query) => retrieveReferenceSnippets(brands, query, 4, 2500),
    onBatch: (batch, total) =>
      report('match', `Batch ${batch} of ${total} · ${requirements.length} line(s)`, (batch - 1) / total),
  });
  report('price', `Pricing ${requirements.length} line(s) and resolving accessories`);
  const pricedRaw = priceLines(requirements, matches, candidates, defaultDiscountPct, pool);
  report('assemble', 'Grouping into boards and feeders');
  const priced = consolidateLines(pricedRaw);
  const bom = groupIntoBom(pricedRaw);
  const matchedCount = priced.filter((l) => l.catalogNo).length;
  return { priced, bom, matchedCount, total: priced.length };
}

/** Map priced pipeline lines into QuoteLine create rows. */
function quoteLineRows(quoteId: number, priced: Awaited<ReturnType<typeof runQuotePipeline>>['priced']) {
  return priced.map((l) => ({
    quoteId,
    lineNo: l.lineNo,
    requirement: l.requirement,
    isAccessory: l.isAccessory,
    family: l.family,
    make: l.make || null,
    catalogNo: l.catalogNo,
    description: l.description,
    quantity: l.quantity,
    listPrice: l.listPrice,
    discountPct: l.discountPct,
    rate: l.rate,
    amount: l.amount,
    confidence: l.confidence,
    matchNote: l.matchNote,
    priceListItemId: l.priceListItemId,
  }));
}

/** quote_lines rows for a knowledge-engine result (flat, verified lines). */
function knowledgeLineRows(quoteId: number, lines: KnowledgeResult['lines']) {
  return lines.map((l) => ({
    quoteId,
    lineNo: l.lineNo,
    requirement: l.requirement,
    isAccessory: l.isAccessory,
    family: l.family,
    make: l.make,
    catalogNo: l.catalogNo,
    description: l.description,
    quantity: l.quantity,
    listPrice: l.listPrice,
    discountPct: l.discountPct,
    rate: l.rate,
    amount: l.amount,
    confidence: l.confidence,
    matchNote: l.matchNote,
    priceListItemId: null,
  }));
}

/** Persist a knowledge-engine BOM (generation or a chat change) on the quote. */
async function saveKnowledgeResult(quoteId: number, provider: string, result: KnowledgeResult, assistantMessage: string) {
  await prisma.$transaction([
    prisma.quoteLine.deleteMany({ where: { quoteId } }),
    prisma.quoteLine.createMany({ data: knowledgeLineRows(quoteId, result.lines) }),
    prisma.quoteMessage.create({ data: { quoteId, role: 'ASSISTANT', content: assistantMessage } }),
    prisma.quote.update({
      where: { id: quoteId },
      data: {
        status: 'COMPLETED',
        provider,
        error: null,
        summary: `Matched ${result.matched}/${result.total} lines.`,
        bomJson: result.boards as unknown as Prisma.InputJsonValue,
        // The catalogue sections this run used — chat follow-ups attach the same.
        knowledgeSectionIds: result.sectionIds ?? Prisma.JsonNull,
      },
    }),
  ]);
}

/** The section ids stored on a quote, or null for "all / full files". */
function quoteSectionIds(quote: { knowledgeSectionIds: Prisma.JsonValue | null }): number[] | null {
  return Array.isArray(quote.knowledgeSectionIds)
    ? quote.knowledgeSectionIds.filter((v): v is number => typeof v === 'number')
    : null;
}

/** The reply that opens / follows a knowledge-engine generation. */
function knowledgeReply(result: KnowledgeResult, brands: string[], ruleNames: string[], lead: string): string {
  const review = result.total - result.matched;
  return (
    `${lead} (${brands.join(', ') || 'brand'}). ` +
    `${result.matched} of ${result.total} line(s) priced from the brand files` +
    (review ? `, ${review} flagged for review.` : '.') +
    (result.summary ? `\n\n${result.summary}` : '') +
    (result.voided.length
      ? `\n\nNot confirmed in the price list (cleared, please verify): ${result.voided.slice(0, 12).join('; ')}` +
        (result.voided.length > 12 ? ` … and ${result.voided.length - 12} more.` : '.')
      : '') +
    `\n\nApplied: ` +
    (ruleNames.length ? `rules ${ruleNames.join(', ')}` : 'no brand rules') +
    `; brand files trained into Claude.` +
    `\n\nAsk me to adjust quantities, swap a part, or explain any line.`
  );
}

/** Run the extract → retrieve → match → price pipeline and persist the lines. */
async function processQuote(quoteId: number, input: CreateQuoteInput, files: StoredFile[]) {
  try {
    const provider = await getLlmProvider();
    if (provider.name === 'stub') {
      throw HttpError.badRequest(
        'No AI provider is configured. Add an OpenAI or Claude API key in Settings → API Keys.',
      );
    }

    // ── Engine "claude": the brand files live in Claude; one request → the BOM.
    if ((await getEffectiveLlmConfig()).quoteEngine === 'claude') {
      const brands = parseBrands(input.brand);
      const promptIds = input.promptIds ?? null;
      setProgress(quoteId, 'read', `Reading ${files.map((f) => f.originalName).join(', ')}`);
      const boqText = await readInputs(
        files.map((f) => ({ fileName: f.originalName, mimeType: f.mimeType, path: f.path })),
      );
      const customer = await prisma.customer.findUnique({ where: { id: input.customerId }, select: { name: true } });
      // The selected rules: trained ones by file id, untrained ones as text.
      const rules = await knowledgeRulesForQuote(brands, promptIds);
      const result = await generateWithKnowledge({
        provider,
        brands,
        ruleFileIds: rules.fileIds,
        rulesText: rules.inlineText,
        customerNotes: input.message ?? '',
        boqText,
        customerName: customer?.name ?? '',
        defaultDiscountPct: input.defaultDiscountPct ?? 0,
        onProgress: (stage, detail) => setProgress(quoteId, stage, detail),
      });
      const ruleNames = (await listPromptsForBrands(brands))
        .filter((p) => (promptIds ? promptIds.includes(p.id) : p.train))
        .map((p) => `${p.brand} · ${p.name || `Rule ${p.id}`}`);
      setProgress(quoteId, 'save', `Saving ${result.lines.length} line(s) and the BOM`);
      await saveKnowledgeResult(quoteId, provider.name, result, knowledgeReply(result, brands, ruleNames, "Here's your draft quote"));
      return;
    }

    const priceListDocumentIds = await resolvePriceListDocumentIds(input);
    if (priceListDocumentIds.length === 0) {
      throw HttpError.badRequest(
        'No ingested price list found for the selected brand(s). Upload and ingest a price list first.',
      );
    }
    const category = input.categoryId
      ? await prisma.productCategory.findUnique({ where: { id: input.categoryId } })
      : null;

    const inputFiles: InputFile[] = files.map((f) => ({
      fileName: f.originalName,
      mimeType: f.mimeType,
      path: f.path,
    }));
    const brands = parseBrands(input.brand);
    const brandLabel = brands.join(', ');
    setProgress(quoteId, 'read', `Reading ${files.map((f) => f.originalName).join(', ')}`);
    const inputText = await readInputs(inputFiles);
    const promptIds = input.promptIds ?? null;

    // Merge the pools of every selected brand's price list into one candidate set.
    const pool = await prisma.priceListItem.findMany({
      where: { documentId: { in: priceListDocumentIds } },
    });
    const { priced, bom, matchedCount, total } = await runQuotePipeline({
      onProgress: (stage, detail, fraction) => setProgress(quoteId, stage, detail, fraction),
      provider,
      inputText,
      brandLabel,
      categoryName: category?.name ?? '',
      defaultDiscountPct: input.defaultDiscountPct ?? 0,
      customerNotes: input.message,
      brandNotes: await getTrainedPromptText(brands, promptIds),
      brands,
      pool,
    });

    // Tell the user exactly what shaped this draft, so they can see their rules
    // and instructions were applied (and which reference files were available).
    const ruleNames = (await listPromptsForBrands(brands))
      .filter((p) => (promptIds ? promptIds.includes(p.id) : p.train))
      .map((p) => `${p.brand} · ${p.name || `Rule ${p.id}`}`);
    const refFiles = await prisma.productDocument.findMany({
      where: { company: { name: { in: brands } }, textStatus: 'COMPLETED', textChars: { gt: 0 } },
      select: { name: true, fileName: true },
    });
    const reviewCount = total - matchedCount;
    const openingMessage =
      `Here's your draft quote (${brandLabel || 'brand'}). ` +
      `I matched ${matchedCount} of ${total} line(s)` +
      (reviewCount ? `, with ${reviewCount} flagged for review.` : '.') +
      `\n\nApplied: ` +
      (ruleNames.length ? `rules ${ruleNames.join(', ')}` : 'no brand rules') +
      (input.message ? '; your instructions' : '') +
      (refFiles.length
        ? `; reference files ${refFiles.map((f) => f.name || f.fileName).join(', ')}`
        : '') +
      `.\n\nAsk me to adjust quantities, swap a part, or explain any line.`;

    setProgress(quoteId, 'save', `Saving ${priced.length} line(s) and the BOM`);
    await prisma.$transaction([
      prisma.quoteLine.deleteMany({ where: { quoteId } }),
      prisma.quoteLine.createMany({ data: quoteLineRows(quoteId, priced) }),
      prisma.quoteMessage.create({
        data: { quoteId, role: 'ASSISTANT', content: openingMessage },
      }),
      prisma.quote.update({
        where: { id: quoteId },
        data: {
          status: 'COMPLETED',
          provider: provider.name,
          error: null,
          summary: `Matched ${matchedCount}/${total} lines.`,
          bomJson: bom as unknown as Prisma.InputJsonValue,
        },
      }),
    ]);
  } catch (err) {
    // Stored on the quote and shown in the chat — the provider's reason in plain words.
    const message = friendlyErrorMessage(err, 'Quote generation failed');
    await prisma.quote.update({
      where: { id: quoteId },
      data: { status: 'FAILED', error: message.slice(0, 2000) },
    });
    throw err;
  } finally {
    clearProgress(quoteId);
  }
}

/** `Customer-Product-DD.MM.YYYY` with filesystem-safe segments (quote's date). */
export function quoteFileBaseName(customer: string, product: string | null, when: Date): string {
  const clean = (s: string) =>
    s
      .trim()
      .replace(/[^\w\s-]+/g, '')
      .replace(/\s+/g, '_')
      .replace(/_+/g, '_')
      .replace(/^_|_$/g, '') || 'NA';
  // Day-first, dot-separated so it doesn't blend with the "-" segment separators.
  const dd = String(when.getDate()).padStart(2, '0');
  const mm = String(when.getMonth() + 1).padStart(2, '0');
  const date = `${dd}.${mm}.${when.getFullYear()}`;
  return [clean(customer), clean(product ?? 'product'), date].join('-');
}

/** Build the downloadable .xlsx for a completed quote. */
export async function buildQuoteXlsx(id: number): Promise<{ buffer: Buffer; fileName: string }> {
  const quote = await prisma.quote.findUnique({
    where: { id },
    include: {
      customer: { select: { name: true } },
      category: { select: { name: true } },
      documents: { orderBy: { id: 'asc' }, take: 1, select: { fileName: true } },
      lines: { orderBy: { lineNo: 'asc' } },
    },
  });
  if (!quote) throw HttpError.notFound('Quote not found');

  // Every chat gets its OWN file name: customer + the BOQ it was made from (or the
  // product category) + date + the quote number — so two quotes for the same
  // customer on the same day never share a name and never replace each other.
  const boqName = quote.documents[0]?.fileName.replace(/\.[^.]+$/, '') ?? null;
  const baseName = `${quoteFileBaseName(quote.customer.name, quote.category?.name ?? boqName, quote.createdAt)}-Q${quote.id}`;
  // A name set from the chat ("rename the file to …") overrides the derived one.
  const nameFor = (fallback: string) => `${quote.downloadName?.trim() || fallback}.xlsx`;

  // Preferred format: the feeder-grouped "Switchgear Report-Board" BOM captured
  // at generation. Header fields are auto-filled from the quote/customer.
  const boards = (quote.bomJson as unknown as BomBoard[] | null) ?? null;
  if (boards && Array.isArray(boards) && boards.length) {
    // Older quotes stored the feeder role on every item ("… — Incoming"); the role
    // belongs on the feeder header only, so strip it from item rows at export.
    for (const b of boards)
      for (const f of b.feeders ?? [])
        for (const it of f.items ?? [])
          it.description = (it.description ?? '').replace(/\s*(?:—|,|-)\s*(?:Incoming|Outgoing)\s*$/i, '');
    const when = quote.createdAt;
    const dd = String(when.getDate()).padStart(2, '0');
    const mm = String(when.getMonth() + 1).padStart(2, '0');
    const buffer = await buildBomWorkbook(
      {
        projectName: quote.title ?? quote.customer.name,
        offerNumber: `JW-${quote.id}`,
        customerName: quote.customer.name,
        revision: `1 / ${dd}-${mm}-${when.getFullYear()}`,
      },
      boards,
    );
    return { buffer, fileName: nameFor(baseName) };
  }

  // The line's product Type (e.g. DN3-630N) lives on the linked price-list item,
  // not on the quote line — resolve it here so the export can show a Type column.
  const itemIds = quote.lines
    .map((l) => l.priceListItemId)
    .filter((id): id is number => id != null);
  const typeById = new Map<number, string | null>();
  if (itemIds.length) {
    const items = await prisma.priceListItem.findMany({
      where: { id: { in: itemIds } },
      select: { id: true, type: true },
    });
    for (const it of items) typeById.set(it.id, it.type);
  }
  // Resolve the Type column. MCCBs carry a frame/series Type on the price-list
  // row (e.g. DN2-250D). Accessories don't, but their description names the
  // frame(s) they fit — pull those out ("Rotary Handle — DN0 Extended ROM" →
  // "DN0"; "Auxiliary Contact — DN2, DN3B, DN3, DN4 …" → "DN2, DN3B, DN3, DN4"),
  // matching how the reference quotes fill the Type column. Anything else (e.g.
  // an MCB) falls back to its Family so the column reads "MCB" instead of blank.
  const resolveType = (l: (typeof quote.lines)[number]): string | null => {
    const itemType = l.priceListItemId != null ? typeById.get(l.priceListItemId) ?? null : null;
    if (itemType) return itemType; // MCCB frame/series, e.g. DN2-250D
    const desc = l.description ?? '';
    // Ground-fault modules are typed by their GF class (GF1/GF2/GF11).
    const gf = /\bGF\d+\b/i.exec(desc);
    if (gf) return gf[0].toUpperCase();
    // MCCB accessories carry a DN/DU frame token — label them the reference way:
    // spreaders (DN-only external part) as "DN", the internal accessories that
    // fit both frames (aux / shunt / rotary handle) as "DU/DN".
    if (/\bD[NUZY]\d/i.test(desc)) return /spreader/i.test(desc) ? 'DN' : 'DU/DN';
    return l.family ?? null; // MCB → "MCB", Meter → "Meter"
  };

  const buffer = await buildQuoteWorkbook(
    { title: quote.title, customerName: quote.customer.name, brand: quote.brand },
    quote.lines.map((l) => ({
      lineNo: l.lineNo,
      requirement: l.requirement,
      isAccessory: l.isAccessory,
      quantity: l.quantity,
      family: l.family,
      make: l.make ?? '',
      type: resolveType(l),
      catalogNo: l.catalogNo,
      description: l.description,
      listPrice: l.listPrice != null ? Number(l.listPrice) : null,
      discountPct: Number(l.discountPct),
      rate: l.rate != null ? Number(l.rate) : null,
      amount: l.amount != null ? Number(l.amount) : null,
      confidence: l.confidence != null ? Number(l.confidence) : 0,
      matchNote: l.matchNote ?? '',
      priceListItemId: l.priceListItemId ?? null,
    })),
  );
  return { buffer, fileName: nameFor(baseName) };
}

/**
 * Append a user message to a quote's chat thread, get the model's reply, and
 * store both. The model is given the quote context (customer, product, and the
 * priced lines) so it can answer questions and suggest refinements.
 */
interface ChatAttachment {
  name: string;
  path: string;
  mimeType: string;
}
interface QuoteEdit {
  op:
    // flat-line ops
    | 'setQuantity'
    | 'setDiscount'
    | 'setDiscountAll'
    | 'removeLine'
    // BOM ops
    | 'keepPerFeeder'
    | 'removeFeeder'
    | 'addFeeder'
    | 'setFeederDiscount'
    | 'addProduct'
    | 'removeItem'
    | 'setItemQuantity'
    | 'setItemDiscount'
    | 'swapSeries';
  lineNo?: number;
  value?: number;
  /** Target series for swapSeries (e.g. "DZ") — every breaker is re-resolved to it. */
  series?: string;
  /** Feeder to target — matched loosely against the feeder name/rating. */
  feeder?: string;
  /** Item to target within a feeder — matched against description/model no. */
  item?: string;
  /** Free-text product to look up in the price list (addProduct / addFeeder). */
  query?: string;
  qty?: number;
  discount?: number;
  /** New feeder name (addFeeder). */
  name?: string;
  /** Products to seed a new feeder with (addFeeder). */
  items?: { query: string; qty?: number; discount?: number }[];
}
const clampPct = (v: number) => Math.max(0, Math.min(100, Number(v)));
const round2 = (n: number) => Math.round(n * 100) / 100;

/** Keep a chat reply to clean human text — never leak JSON/BOM dumps. */
function sanitizeReply(raw: unknown): string {
  let s = String(raw ?? '').trim();
  if (!s) return '';
  s = s.replace(/^```(?:json)?/i, '').replace(/```$/i, '').trim();
  // Structured data (an object/array or product-JSON keys) is not a reply — drop it.
  if (/^[[{]/.test(s) || /"(modelNo|discountPct|feeders|items|bom|catalogNo|boardQty)"\s*:/i.test(s)) return '';
  return s.slice(0, 2000);
}

/** Strip a filename to a safe .xlsx base. */
function safeName(name: string): string | null {
  const base = name.trim().replace(/\.xlsx$/i, '').replace(/[^\w\s.-]+/g, '').replace(/\s+/g, '_').slice(0, 120);
  return base || null;
}

/** Load every price-list row for the quote's brand(s) — the pool the chat can
 *  pull real, correctly-priced products from (e.g. adding DZ2/DZ4/DZ6/DZ7). */
async function loadBrandPool(brand: string | null): Promise<PriceListItem[]> {
  const brands = parseBrands(brand);
  if (!brands.length) return [];
  return prisma.priceListItem.findMany({
    where: { brand: { in: brands }, document: { train: true } },
  });
}

/**
 * Resolve a free-text product query to a real price-list item, brand-scoped.
 * Rejects weak/ambiguous matches (a bare series like "DZ4" with no rating hits
 * only a keyword and scores low) so the chat reports them instead of silently
 * adding the wrong (often cheapest) row — the caller then asks to be specific.
 */
const MIN_RESOLVE_SCORE = 40;
function resolveProduct(
  pool: PriceListItem[],
  query: string,
  brand: string | null,
  qty = 1,
  discount = 0,
): BomItem | null {
  const keywords = query
    .split(/[^a-z0-9]+/i)
    .map((t) => t.trim())
    .filter(Boolean);
  if (!keywords.length) return null;
  const cands = rankCandidates(pool, { keywords, brand: brand ?? undefined, limit: 8 });
  if (!cands.length) return null;
  // When the query looks like a breaker (rating + poles, or names MCCB/MCB),
  // prefer an actual breaker row (has rating AND poles) over accessories that
  // merely share the series text — a "Shunt Release"/"Terminal Shroud" for the
  // same series would otherwise outrank the breaker itself.
  const wantsBreaker =
    (/\b\d+\s*a\b/i.test(query) && /\b\d+\s*p\b/i.test(query)) || /\b(mccb|mcb|breaker)\b/i.test(query);
  const isBreakerRow = (it: PriceListItem) => it.ratingAmp != null && it.poles != null;
  let top = cands[0];
  if (wantsBreaker) {
    const b = cands.find((c) => c.score >= MIN_RESOLVE_SCORE && isBreakerRow(c.item));
    if (b) top = b;
  }
  if (!top || top.score < MIN_RESOLVE_SCORE) return null;
  const it = top.item;
  return {
    description: it.description ?? query,
    modelNo: it.catalogNo ?? null,
    make: brand,
    qty: Math.max(1, Math.round(qty)),
    catalogPrice: it.listPrice != null ? Number(it.listPrice) : null,
    discountPct: clampPct(discount),
  };
}

/**
 * Resolve a breaker to the SMALLEST of an explicit frame list that actually offers
 * its rating/poles (e.g. frames DZ2,DZ4,DZ6,DZ7 → 160A picks DZ2, 250A picks DZ4).
 * Returns null if none of the listed frames carry that exact rating.
 */
function resolveBreakerInFrames(
  pool: PriceListItem[],
  frames: string[],
  spec: { rating: number; poles: number; ka: number | null; release: string },
  brand: string | null,
): BomItem | null {
  for (const fr of frames) {
    const q = `${fr} ${spec.rating}A ${spec.poles}P ${spec.ka ? `${spec.ka}kA ` : ''}${spec.release}`.trim();
    const keywords = q.split(/[^a-z0-9]+/i).filter(Boolean);
    const cands = rankCandidates(pool, { keywords, brand: brand ?? undefined, limit: 8 });
    const hit = cands.find(
      (c) =>
        c.score >= MIN_RESOLVE_SCORE &&
        c.item.ratingAmp != null &&
        Number(c.item.ratingAmp) === spec.rating &&
        c.item.poles != null &&
        Number(c.item.poles) === spec.poles &&
        new RegExp(`^${fr}`, 'i').test(c.item.catalogNo),
    );
    if (hit)
      return {
        description: hit.item.description ?? q,
        modelNo: hit.item.catalogNo,
        make: brand,
        qty: 1,
        catalogPrice: hit.item.listPrice != null ? Number(hit.item.listPrice) : null,
        discountPct: 0,
      };
  }
  return null;
}

/** Detect an MCCB/breaker item and pull its spec from the description. */
function breakerSpec(it: BomItem): { rating: number; poles: number; ka: number | null; release: string } | null {
  const d = it.description ?? '';
  // Only real MCCBs — exclude the "6A, 1P, MCB" control MCB and any accessory.
  const isMccb = /\bMCCB\b/i.test(d) || (/\d+\s*A,\s*\d+\s*P/i.test(d) && /release/i.test(d) && !/\bMCB\b/i.test(d));
  if (!isMccb) return null;
  const rating = Number(/(\d+)\s*A\b/i.exec(d)?.[1]);
  const poles = Number(/(\d+)\s*P\b/i.exec(d)?.[1]);
  if (!rating || !poles) return null;
  const ka = Number(/(\d+)\s*kA/i.exec(d)?.[1]) || null;
  const release = /microprocessor/i.test(d)
    ? 'Microprocessor'
    : /thermal[- ]?magnetic/i.test(d)
      ? 'Thermal-Magnetic'
      : '';
  return { rating, poles, ka, release };
}

/** All frame codes a price-list row covers, expanding grouped forms:
 *  "DZ6/7" → {DZ6,DZ7}; "DZ1, DZ2-160" → {DZ1,DZ2}; "DZ1/2/4" → {DZ1,DZ2,DZ4}. */
function frameSet(desc: string): Set<string> {
  const s = new Set<string>();
  for (const m of desc.matchAll(/DZ\s?(\d)((?:\/\d)*)/gi)) {
    s.add(`DZ${m[1]}`);
    if (m[2]) for (const d of m[2].split('/')) if (d) s.add(`DZ${d}`);
  }
  return s;
}

/** Accessory families a breaker carries, and how they read in the price list. */
const ACCESSORY_TYPES: { detect: RegExp; match: RegExp; kind: 'spreader' | 'rotary' | 'aux' | 'shunt' | 'uvr' }[] = [
  { detect: /spreader/i, match: /spreader/i, kind: 'spreader' },
  { detect: /rotary|\bROM\b|handle/i, match: /rotary/i, kind: 'rotary' },
  { detect: /aux[il]+ary|\bTAC\b/i, match: /aux[il]+ary/i, kind: 'aux' },
  { detect: /shunt/i, match: /shunt/i, kind: 'shunt' },
  { detect: /under\s*voltage|\bUVR\b/i, match: /under\s*voltage|\bUVR\b/i, kind: 'uvr' },
];

/** Re-resolve a breaker accessory (spreader/handle/aux/…) to a target frame. */
function resolveAccessoryToFrame(
  pool: PriceListItem[],
  item: BomItem,
  frame: string,
  breakerPoles: number | null,
): BomItem | null {
  const d = item.description ?? '';
  const type = ACCESSORY_TYPES.find((t) => t.detect.test(d));
  if (!type) return null;
  let cands = pool.filter((p) => type.match.test(p.description ?? '') && frameSet(p.description ?? '').has(frame));
  if (!cands.length) return null;
  // Spreaders differ by pole count — keep the breaker's poles (or the ones stated).
  if (type.kind === 'spreader') {
    const poles = Number(/(\d)\s*Pole/i.exec(d)?.[1]) || breakerPoles || null;
    if (poles) {
      const byPole = cands.filter((p) => new RegExp(`\\b${poles}\\s*Pole`, 'i').test(p.description ?? ''));
      if (byPole.length) cands = byPole;
    }
  }
  // Rotary handle: keep Direct vs Extended ROM (the "(Direct/Extended)" prefix is
  // on every row, so match the trailing "… Direct ROM" / "… Extended ROM").
  if (type.kind === 'rotary') {
    const rom = /extended\s*ROM/i.test(d) ? 'Extended ROM' : /direct\s*ROM/i.test(d) ? 'Direct ROM' : null;
    if (rom) {
      const byRom = cands.filter((p) => new RegExp(`${rom}\\s*$|${rom}\\b`, 'i').test(p.description ?? ''));
      if (byRom.length) cands = byRom;
    }
  }
  cands.sort((a, b) => Number(a.listPrice ?? 0) - Number(b.listPrice ?? 0));
  const row = cands[0];
  if (!row) return null;
  return {
    description: row.description,
    modelNo: row.catalogNo,
    make: item.make,
    qty: item.qty,
    catalogPrice: row.listPrice != null ? Number(row.listPrice) : null,
    discountPct: item.discountPct,
  };
}

/**
 * Swap every breaker in the BOM to a different series (e.g. DN → "DZ" double-break),
 * re-resolving each to the target series at its OWN rating/poles/kA — the price list
 * picks the right frame (DZ7/DZ6/DZ4/DZ0…) and real price. Each breaker's ACCESSORIES
 * (spreader terminals, rotary handle, aux contact, shunt/UV release) are then converted
 * to that same frame so the feeder is fully consistent. General for any series.
 */
export function swapSeriesInBoards(
  boards: BomBoard[],
  series: string,
  pool: PriceListItem[],
  brand: string | null,
): { swapped: number; accessories: number; failures: string[] } {
  let swapped = 0;
  let accessories = 0;
  const failures: string[] = [];
  // If the user named explicit frames ("DZ2, DZ4, DZ6, DZ7"), prefer the smallest
  // listed frame that offers each rating; otherwise ("DZ") let the pool decide.
  const frameList = [...series.matchAll(/([A-Za-z]{1,4})\s?(\d)/g)]
    .map((m) => `${(m[1] ?? '').toUpperCase()}${m[2] ?? ''}`)
    .sort((a, b) => Number(a.replace(/\D/g, '')) - Number(b.replace(/\D/g, '')));
  const baseSeries = (/^[A-Za-z]+/.exec(series.trim())?.[0] ?? series).toUpperCase();
  for (const b of boards)
    for (const f of b.feeders) {
      // Pass 1 — swap the breaker(s) and note the frame + poles for this feeder.
      let frame: string | null = null;
      let breakerPoles: number | null = null;
      for (const it of f.items) {
        const spec = breakerSpec(it);
        if (!spec) continue;
        let r =
          (frameList.length ? resolveBreakerInFrames(pool, frameList, spec, brand) : null) ??
          resolveProduct(
            pool,
            `${baseSeries} ${spec.rating}A ${spec.poles}P ${spec.ka ? `${spec.ka}kA ` : ''}${spec.release}`.trim(),
            brand,
          );
        // The keyword fallback can land on a same-rating breaker of ANOTHER
        // series when the target series has no such rating — that is not a swap,
        // it is a silent downgrade, so treat it as "no match" instead.
        const inSeries = new RegExp(`\\b${baseSeries}\\d`, 'i');
        if (r && !inSeries.test(`${r.modelNo ?? ''} ${r.description ?? ''}`)) r = null;
        if (!r || !r.modelNo) {
          failures.push(`${spec.rating}A ${spec.poles}P`);
          continue;
        }
        if (r.modelNo !== it.modelNo) {
          it.modelNo = r.modelNo;
          it.description = r.description;
          it.catalogPrice = r.catalogPrice;
          swapped++;
        }
        frame = /^DZ\d/i.exec(r.modelNo)?.[0]?.toUpperCase() ?? frame;
        breakerPoles = spec.poles;
      }
      // Pass 2 — convert this feeder's accessories to the same frame.
      if (frame)
        for (const it of f.items) {
          if (breakerSpec(it)) continue; // skip the breaker itself
          const r = resolveAccessoryToFrame(pool, it, frame, breakerPoles);
          if (r && r.modelNo && r.modelNo !== it.modelNo) {
            it.modelNo = r.modelNo;
            it.description = r.description;
            it.catalogPrice = r.catalogPrice;
            accessories++;
          }
        }
    }
  return { swapped, accessories, failures };
}

/** Loose feeder matcher: a plain rating ("630") hits "MCCB 630 A"; any other
 *  text is a case-insensitive substring of the feeder name. Empty = all feeders. */
function feederMatches(name: string, target?: string): boolean {
  if (!target || !target.trim()) return true;
  const t = target.trim();
  if (/^\d+$/.test(t)) return new RegExp(`\\b${t}\\s*A\\b`, 'i').test(name);
  return name.toLowerCase().includes(t.toLowerCase());
}

/** Loose item matcher against description / model number. */
function itemMatches(it: BomItem, target?: string): boolean {
  if (!target || !target.trim()) return false;
  const t = target.trim().toLowerCase();
  return (
    (it.description ?? '').toLowerCase().includes(t) ||
    (it.modelNo ?? '').toLowerCase().includes(t)
  );
}

/**
 * Re-price a whole BOM the LLM returned (the general "do anything" path). The
 * model may restructure freely, but PRICES are never trusted from the model:
 * every item is re-priced from the brand's price list — by its catalog/model
 * number when given, else resolved from its description. Items that can't be
 * priced are kept (so the structure is preserved) and reported as problems.
 */
function repriceBoards(
  raw: unknown,
  pool: PriceListItem[],
  brand: string | null,
): { boards: BomBoard[]; problems: string[] } {
  const problems: string[] = [];
  // Catalog → row (prefer a row that carries a rating, i.e. the real product).
  const byCatalog = new Map<string, PriceListItem>();
  for (const it of pool) {
    const key = it.catalogNo?.toUpperCase();
    if (!key) continue;
    const cur = byCatalog.get(key);
    if (!cur || (it.ratingAmp != null && cur.ratingAmp == null)) byCatalog.set(key, it);
  }
  const asArray = (v: unknown): any[] => (Array.isArray(v) ? v : []);
  const boards: BomBoard[] = asArray(raw).map((b: any) => ({
    name: String(b?.name ?? 'Board'),
    boardQty: Math.max(1, Math.round(Number(b?.boardQty ?? 1)) || 1),
    feeders: asArray(b?.feeders).map((f: any) => ({
      name: String(f?.name ?? 'Feeder'),
      feederQty: Math.max(1, Math.round(Number(f?.feederQty ?? 1)) || 1),
      items: asArray(f?.items).map((it: any): BomItem => {
        const modelNo = String(it?.modelNo ?? it?.catalogNo ?? '').trim() || null;
        const desc = String(it?.description ?? '').trim();
        const qty = Math.max(1, Math.round(Number(it?.qty ?? 1)) || 1);
        const discountPct = clampPct(Number(it?.discountPct ?? 0));
        // 1) authoritative price by catalog number
        if (modelNo) {
          const row = byCatalog.get(modelNo.toUpperCase());
          if (row)
            return {
              description: desc || row.description,
              modelNo: row.catalogNo,
              make: brand,
              qty,
              catalogPrice: row.listPrice != null ? Number(row.listPrice) : null,
              discountPct,
            };
        }
        // 2) resolve by description text
        if (desc) {
          const r = resolveProduct(pool, desc, brand, qty, discountPct);
          if (r) return r;
        }
        // 3) keep the row but leave it unpriced, and flag it
        problems.push(`no price for "${desc || modelNo || 'item'}"`);
        return { description: desc || modelNo || 'Item', modelNo, make: brand, qty, catalogPrice: null, discountPct };
      }),
    })),
  }));
  return { boards, problems };
}

/**
 * Discuss / EDIT a quote from the chat thread. The assistant is agentic: it can
 * apply changes to the quote (line quantities, discounts, remove a line) and
 * rename the download — the model returns a JSON { reply, edits?, fileName? },
 * we apply the edits to the stored lines, and the Download button then serves
 * the updated .xlsx. Everything goes through the configured LLM provider.
 */
export async function addQuoteMessage(
  quoteId: number,
  content: string,
  attachments: ChatAttachment[] = [],
) {
  const quote = await prisma.quote.findUnique({
    where: { id: quoteId },
    include: {
      customer: { select: { name: true } },
      category: { select: { name: true } },
      documents: { orderBy: { id: 'asc' } },
      lines: { orderBy: { lineNo: 'asc' } },
      messages: { orderBy: { createdAt: 'asc' } },
    },
  });
  if (!quote) throw HttpError.notFound('Quote not found');

  await prisma.quoteMessage.create({
    data: {
      quoteId,
      role: 'USER',
      content,
      attachments: attachments.length ? (attachments as unknown as Prisma.InputJsonValue) : undefined,
    },
  });

  const provider = await getLlmProvider();

  // ── Engine "claude": the brand files are attached to every turn. A new BOQ or
  // "regenerate" produces a fresh BOM; anything else is a question or a change
  // that Claude answers with the complete updated BOM (verified before saving).
  if ((await getEffectiveLlmConfig()).quoteEngine === 'claude' && provider.name !== 'stub') {
    const brands = parseBrands(quote.brand);
    const rules = await knowledgeRulesForQuote(brands, quotePromptIds(quote));
    const ruleNames = (await listPromptsForBrands(brands))
      .filter((p) => {
        const ids = quotePromptIds(quote);
        return ids ? ids.includes(p.id) : p.train;
      })
      .map((p) => `${p.brand} · ${p.name || `Rule ${p.id}`}`);
    const wantsRegen = /\b(re-?generate|re-?run|re-?build|redo|generate again|run again|new output)\b/i.test(content);
    const sources: ChatAttachment[] = attachments.length
      ? attachments
      : wantsRegen
        ? quote.documents.map((d) => ({ name: d.fileName, path: d.storagePath, mimeType: d.mimeType }))
        : [];
    try {
      if (sources.length) {
        setProgress(quoteId, 'read', `Reading ${sources.map((a) => a.name).join(', ')}`);
        const boqText = await readInputs(sources.map((a) => ({ fileName: a.name, mimeType: a.mimeType, path: a.path })));
        const result = await generateWithKnowledge({
          provider,
          brands,
          ruleFileIds: rules.fileIds,
          rulesText: rules.inlineText,
          customerNotes: content.trim(),
          boqText,
          customerName: quote.customer.name,
          defaultDiscountPct: 0,
          // A new BOQ needs a fresh section pick; a plain "regenerate" reuses the last.
          sectionIds: attachments.length ? null : quoteSectionIds(quote),
          onProgress: (stage, detail) => setProgress(quoteId, stage, detail),
        });
        setProgress(quoteId, 'save', `Saving ${result.lines.length} line(s) and the BOM`);
        const reply = knowledgeReply(result, brands, ruleNames, `Regenerated the quote from ${sources.map((a) => a.name).join(', ')}`);
        await saveKnowledgeResult(quoteId, provider.name, result, reply);
        const assistant = await prisma.quoteMessage.findFirstOrThrow({
          where: { quoteId, role: 'ASSISTANT' },
          orderBy: { createdAt: 'desc' },
        });
        return { ...assistant, quoteChanged: true };
      }

      setProgress(quoteId, 'extract', 'Claude is reading the brand files and your message');
      const chat = await chatWithKnowledge({
        provider,
        brands,
        ruleFileIds: rules.fileIds,
        rulesText: rules.inlineText,
        customerName: quote.customer.name,
        currentBoards: (quote.bomJson as unknown as BomBoard[] | null) ?? null,
        history: quote.messages.map((m) => ({ role: m.role.toLowerCase() as LlmMessage['role'], content: m.content })),
        message: content || (attachments.length ? '(see attached files)' : ''),
        defaultDiscountPct: 0,
        sectionIds: quoteSectionIds(quote),
      });
      let changed = false;
      const dl = chat.fileName ? safeName(chat.fileName) : null;
      if (dl) {
        await prisma.quote.update({ where: { id: quoteId }, data: { downloadName: dl } });
        changed = true;
      }
      if (chat.result) {
        setProgress(quoteId, 'save', `Saving ${chat.result.lines.length} line(s) and the BOM`);
        const reply =
          (chat.reply || 'Updated the quote.') +
          (chat.result.voided.length
            ? `\n\nNot confirmed in the price list (cleared, please verify): ${chat.result.voided.slice(0, 12).join('; ')}.`
            : '') +
          ' The updated Excel is ready to download.';
        await saveKnowledgeResult(quoteId, provider.name, chat.result, reply);
        const assistant = await prisma.quoteMessage.findFirstOrThrow({
          where: { quoteId, role: 'ASSISTANT' },
          orderBy: { createdAt: 'desc' },
        });
        return { ...assistant, quoteChanged: true };
      }
      const assistant = await prisma.quoteMessage.create({
        data: { quoteId, role: 'ASSISTANT', content: chat.reply || 'Okay.' },
      });
      return { ...assistant, quoteChanged: changed };
    } finally {
      clearProgress(quoteId);
    }
  }

  // ── Chat-driven REGENERATION ────────────────────────────────────────────────
  // If the user attached file(s) in the chat, treat them as a new/updated BOQ and
  // re-run the FULL generation pipeline (extract → retrieve → match → price →
  // group) against them — same engine as the initial quote. Any typed message is
  // passed as extra steering, so "regenerate from this, only the DZ series" or
  // "target the 630A feeder" is honored during extraction. The chat history is
  // kept (unlike first generation, which clears it).
  //
  // Asking to regenerate WITHOUT a file re-runs it on the quote's own BOQ, with
  // whatever brands and rules the chat has NOW — the way to get a fresh output
  // after changing the rule or brand selection.
  const wantsRegenerate = /\b(re-?generate|re-?run|re-?build|redo|generate again|run again|new output)\b/i.test(content);
  const sources: ChatAttachment[] = attachments.length
    ? attachments
    : wantsRegenerate
      ? quote.documents.map((d) => ({ name: d.fileName, path: d.storagePath, mimeType: d.mimeType }))
      : [];
  if (sources.length && provider.name !== 'stub') {
    // The chat request stays synchronous, but the live progress is published so
    // the client can poll it while it waits for the reply.
    setProgress(quoteId, 'read', `Reading ${sources.map((a) => a.name).join(', ')}`);
    const inputFiles = sources.map((a) => ({ fileName: a.name, mimeType: a.mimeType, path: a.path }));
    const inputText = await readInputs(inputFiles).finally(() => clearProgress(quoteId));
    const looksReadable = inputText.replace(/=====.*?=====/g, '').replace(/\[could not read[^\]]*\]/g, '').trim();
    if (looksReadable.length > 20) {
      setProgress(quoteId, 'collect', 'Loading price lists, rules and reference text');
      const pool = await loadBrandPool(quote.brand);
      const steer = content.trim();
      const { priced, bom, matchedCount, total } = await runQuotePipeline({
        onProgress: (stage, detail, fraction) => setProgress(quoteId, stage, detail, fraction),
        provider,
        inputText,
        brandLabel: quote.brand ?? '',
        categoryName: quote.category?.name ?? '',
        defaultDiscountPct: 0,
        customerNotes: steer,
        brandNotes: await getTrainedPromptText(parseBrands(quote.brand), quotePromptIds(quote)),
        brands: parseBrands(quote.brand),
        pool,
      }).catch((err) => {
        clearProgress(quoteId);
        throw err;
      });
      setProgress(quoteId, 'save', `Saving ${priced.length} line(s) and the BOM`);
      await prisma.$transaction([
        prisma.quoteLine.deleteMany({ where: { quoteId } }),
        prisma.quoteLine.createMany({ data: quoteLineRows(quoteId, priced) }),
        prisma.quote.update({
          where: { id: quoteId },
          data: {
            status: 'COMPLETED',
            error: null,
            summary: `Matched ${matchedCount}/${total} lines.`,
            bomJson: bom as unknown as Prisma.InputJsonValue,
          },
        }),
      ]).finally(() => clearProgress(quoteId));
      const feederCount = bom.reduce((n, b) => n + b.feeders.length, 0);
      const itemCount = bom.reduce((n, b) => n + b.feeders.reduce((m, f) => m + f.items.length, 0), 0);
      const brands = parseBrands(quote.brand);
      const ruleNames = (await listPromptsForBrands(brands))
        .filter((p) => {
          const ids = quotePromptIds(quote);
          return ids ? ids.includes(p.id) : p.train;
        })
        .map((p) => `${p.brand} · ${p.name || `Rule ${p.id}`}`);
      const reply =
        `Regenerated the quote from ${sources.map((a) => a.name).join(', ')}` +
        (attachments.length === 0 && content.trim() ? ` (${content.trim()})` : '') +
        ` — ${feederCount} feeder(s), ${itemCount} item(s), matched ${matchedCount}/${total} line(s).` +
        `\n\nApplied: brands ${brands.join(', ') || '—'}; ` +
        (ruleNames.length ? `rules ${ruleNames.join(', ')}` : 'no brand rules') +
        `. The updated Excel is ready to download.`;
      const assistant = await prisma.quoteMessage.create({
        data: { quoteId, role: 'ASSISTANT', content: reply },
      });
      return { ...assistant, quoteChanged: true };
    }

    // Files were attached but nothing readable came out of them — say so plainly
    // (naming each file's problem) instead of letting the chat guess.
    const problems = [...inputText.matchAll(/\[could not read ([^:]+): ([^\]]*)\]/g)].map(
      (m) => `${m[1]} — ${m[2]}`,
    );
    const reply =
      `I couldn't read any text from ${sources.map((a) => a.name).join(', ')}` +
      (problems.length ? ` (${problems.join('; ')})` : '') +
      '. I can read PDF, Excel/CSV, Word and text files directly, and photos or scanned PDFs with the AI. ' +
      'Please check the file and attach it again.';
    const assistant = await prisma.quoteMessage.create({
      data: { quoteId, role: 'ASSISTANT', content: reply },
    });
    return { ...assistant, quoteChanged: false };
  }

  const linesText = quote.lines
    .map(
      (l) =>
        `#${l.lineNo} ${l.catalogNo ?? '(review)'} — ${l.description ?? l.requirement} ` +
        `x${l.quantity} @${l.listPrice ?? '?'} disc ${l.discountPct}% = ${l.amount ?? '?'}`,
    )
    .join('\n');
  const attachNote = attachments.length
    ? `\n\nThe user attached: ${attachments.map((a) => a.name).join(', ')}.`
    : '';

  // The brand's knowledge, from the Brands page: its trained keyword prompts
  // (rules) and the passages of its reference files that match this message.
  const brands = parseBrands(quote.brand);
  const [brandNotes, snippets] = await Promise.all([
    getTrainedPromptText(brands, quotePromptIds(quote)),
    retrieveReferenceSnippets(brands, content),
  ]);
  const knowledge =
    (brandNotes ? `\n\nBRAND RULES (the user's saved keyword prompts — follow them):\n${brandNotes}` : '') +
    (snippets.length
      ? `\n\nREFERENCE TEXT (passages from the brand's reference files that match the message; quote from them when answering questions):\n` +
        snippets.map((s) => `--- ${s.file} ---\n${s.text}`).join('\n')
      : '');

  // The downloadable file is built from the feeder-grouped BOM (bomJson) when it
  // exists — so chat edits must change THAT, not the flat lines. Detect the format.
  const boards = (quote.bomJson as unknown as BomBoard[] | null) ?? null;
  const isBom = Array.isArray(boards) && boards.length > 0;

  // For BOM quotes, load the brand price-list pool up-front — used both to feed
  // the model real candidate products and to re-price whatever it returns.
  const brandPool = isBom ? await loadBrandPool(quote.brand) : [];
  const msgKeywords = content
    .split(/[^a-z0-9]+/i)
    .map((t) => t.trim())
    .filter((t) => t.length > 1);
  const candidates =
    isBom && msgKeywords.length
      ? rankCandidates(brandPool, { keywords: msgKeywords, brand: quote.brand ?? undefined, limit: 20 })
      : [];
  const candText = candidates.length
    ? `\nMatching products in the ${quote.brand ?? ''} price list (use these EXACT modelNo values; prices are filled automatically):\n` +
      candidates.map((c) => `- ${c.item.catalogNo} | ₹${c.item.listPrice ?? '?'} | ${c.item.description}`).join('\n') +
      '\n'
    : '';

  // Compact structure summary (feeder names + item counts) — small + reliable,
  // so the model returns tiny structured edits instead of echoing the whole BOM.
  const structure = isBom
    ? boards!
        .map(
          (b) =>
            `Board "${b.name}" (${b.feeders.length} feeders):\n` +
            b.feeders
              .map(
                (f) =>
                  `  - "${f.name}" ×${f.feederQty}: ${f.items.length} items ` +
                  `[${f.items.slice(0, 3).map((i) => i.modelNo || i.description.slice(0, 16)).join(', ')}${f.items.length > 3 ? ', …' : ''}]`,
              )
              .join('\n'),
        )
        .join('\n')
    : '';

  const system = isBom
    ? `You are an agentic quotation assistant editing a feeder-grouped BOM (boards → feeders → items) ` +
      `for customer "${quote.customer.name}", brand "${quote.brand ?? ''}". Make WHATEVER change the user asks, ` +
      `combining as many ops as needed.\n\n` +
      `CURRENT BOM:\n${structure}\n${candText}${attachNote}${knowledge}\n\n` +
      `Respond with ONLY a JSON object: { "reply": string, "edits"?: Edit[], "fileName"?: string }\n` +
      `Ops:\n` +
      `- swapSeries {op:"swapSeries", series:"<e.g. DZ  OR  DZ2,DZ4,DZ6,DZ7>"} — switch EVERY breaker in the quote to another series, keeping each one's rating/poles/kA, and convert its accessories too. USE THIS when the user asks to change/convert the MCCBs to a series like DZ / "double break". If the user names specific frames (e.g. "DZ2, DZ4, DZ6, DZ7"), pass them ALL comma-joined in "series" — the tool then uses the smallest listed frame that offers each rating. One edit does the whole panel.\n` +
      `- addProduct {op:"addProduct", feeder:"<name/rating>", query:"<full product spec>", qty?, discount?} — for a breaker put series+rating(A)+poles(P)+kA in query (e.g. "DZ4 250A 4P"), or use a modelNo from the matching-products list. Creates the feeder if it doesn't exist.\n` +
      `- addFeeder {op:"addFeeder", name, qty?, items?:[{query, qty?, discount?}]}\n` +
      `- removeItem {op:"removeItem", feeder?, item:"<text>"} ; removeFeeder {op:"removeFeeder", feeder:"<name/rating>"}\n` +
      `- setItemQuantity {op:"setItemQuantity", feeder?, item, value} ; setItemDiscount {op:"setItemDiscount", feeder?, item, value}\n` +
      `- setFeederDiscount {op:"setFeederDiscount", feeder, value} ; keepPerFeeder {op:"keepPerFeeder", value} ; setDiscountAll {op:"setDiscountAll", value}\n` +
      `- fileName (rename the download)\n` +
      `To LIMIT the quote to one series, removeFeeder/removeItem the others. Prices are filled from the price list automatically — never invent a price or a product not asked for. ` +
      `Only claim a change if you return matching edits.\n` +
      `IMPORTANT: "reply" is plain human text — a short answer of a few sentences at most (for a question, answer it from the quote, the brand rules and the reference text). NEVER put JSON, a BOM, or a product list inside "reply". Return ONLY the JSON object, no code fence.`
    : `You are an agentic quotation assistant that EDITS a quote for customer "${quote.customer.name}"` +
      (quote.category ? ` (product: ${quote.category.name}, brand: ${quote.brand ?? ''})` : '') +
      `. Current quote lines:\n${linesText}${attachNote}${knowledge}\n\n` +
      `Respond with ONLY a JSON object: { "reply": string, "edits"?: Edit[], "fileName"?: string }\n` +
      `Edit ops: setQuantity{lineNo,value}, setDiscount{lineNo,value}, setDiscountAll{value}, removeLine{lineNo}, fileName.\n` +
      `Unit PRICES come from the price list; quantities/discounts can change. Only claim a change if you return the matching edits. ` +
      `"reply" is plain human text, a few sentences at most, never JSON. For questions, fill only "reply". Return ONLY the JSON, no code fence.`;

  const history: LlmMessage[] = [
    { role: 'system', content: system },
    ...quote.messages.map((m) => ({
      role: m.role.toLowerCase() as LlmMessage['role'],
      content: m.content,
    })),
    { role: 'user', content: content || (attachments.length ? '(see attached files)' : '') },
  ];

  let reply = '';
  let edits: QuoteEdit[] = [];
  let fileName: string | undefined;
  let newBom: unknown = null;
  try {
    const raw = await provider.complete(history, { json: true, maxTokens: 2000, label: 'quote:chat' });
    const cleaned = raw.replace(/^```(?:json)?/i, '').replace(/```$/i, '').trim();
    const start = cleaned.search(/[[{]/);
    const parsed = JSON.parse(start > 0 ? cleaned.slice(start) : cleaned) as {
      reply?: string;
      edits?: QuoteEdit[];
      fileName?: string;
      bom?: unknown;
    };
    reply = sanitizeReply(parsed.reply);
    edits = Array.isArray(parsed.edits) ? parsed.edits : [];
    fileName = parsed.fileName ? String(parsed.fileName) : undefined;
    if (Array.isArray(parsed.bom) && parsed.bom.length) newBom = parsed.bom;
  } catch {
    // Never echo raw/JSON model output into the chat — keep it clean.
    reply = '';
  }

  let changed = false;
  const summary: string[] = [];
  const problems: string[] = [];

  if (isBom && newBom) {
    // General "do anything" path: the model returned the COMPLETE new BOM. Trust
    // its STRUCTURE, but re-price every item from the price list (never the model).
    const { boards: repriced, problems: priceProblems } = repriceBoards(newBom, brandPool, quote.brand);
    if (repriced.length) {
      await prisma.quote.update({
        where: { id: quoteId },
        data: { bomJson: repriced as unknown as Prisma.InputJsonValue },
      });
      changed = true;
      const feederCount = repriced.reduce((n, b) => n + b.feeders.length, 0);
      const itemCount = repriced.reduce((n, b) => n + b.feeders.reduce((m, f) => m + f.items.length, 0), 0);
      summary.push(`rebuilt the BOM: ${feederCount} feeder(s), ${itemCount} item(s)`);
      problems.push(...priceProblems);
    }
  } else if (isBom) {
    // Targeted-edit path for BOM quotes. The pool is already loaded (brandPool).
    const nb: BomBoard[] = JSON.parse(JSON.stringify(boards));
    const allFeeders = () => nb.flatMap((b) => b.feeders);
    const getPool = async () => brandPool;
    const failed = problems;

    for (const e of edits) {
      switch (e.op) {
        case 'swapSeries': {
          const series = (e.series ?? e.query ?? '').trim();
          if (!series) break;
          const { swapped, accessories, failures } = swapSeriesInBoards(nb, series, await getPool(), quote.brand);
          if (swapped > 0 || accessories > 0) {
            changed = true;
            summary.push(
              `switched ${swapped} breaker(s)` +
                (accessories ? ` + ${accessories} accessory item(s)` : '') +
                ` to the ${series} series`,
            );
          }
          if (failures.length)
            failed.push(`no ${series} match for: ${[...new Set(failures)].join(', ')}`);
          break;
        }
        case 'keepPerFeeder': {
          const n = Math.max(1, Math.round(Number(e.value ?? 0)));
          if (!n) break;
          let removed = 0;
          for (const f of allFeeders()) {
            const before = f.items.length;
            f.items = f.items.slice(0, n);
            removed += before - f.items.length;
          }
          if (removed > 0) {
            changed = true;
            summary.push(`kept ${n} item(s) per feeder (removed ${removed})`);
          }
          break;
        }
        case 'setDiscountAll': {
          if (e.value == null) break;
          const d = clampPct(e.value);
          let c = 0;
          for (const f of allFeeders()) for (const it of f.items) ((it.discountPct = d), c++);
          if (c) {
            changed = true;
            summary.push(`applied ${d}% discount to all items`);
          }
          break;
        }
        case 'setFeederDiscount': {
          if (e.value == null) break;
          const d = clampPct(e.value);
          let c = 0;
          for (const f of allFeeders())
            if (feederMatches(f.name, e.feeder)) for (const it of f.items) ((it.discountPct = d), c++);
          if (c) {
            changed = true;
            summary.push(`set ${d}% discount on ${e.feeder ?? 'the'} feeder(s)`);
          }
          break;
        }
        case 'removeFeeder': {
          const target = e.feeder ?? (e.value != null ? String(Math.round(Number(e.value))) : '');
          if (!target) break;
          let rem = 0;
          for (const b of nb) {
            const before = b.feeders.length;
            b.feeders = b.feeders.filter((f) => !feederMatches(f.name, target));
            rem += before - b.feeders.length;
          }
          if (rem) {
            changed = true;
            summary.push(`removed feeder(s) matching "${target}"`);
          }
          break;
        }
        case 'removeItem': {
          if (!e.item) break;
          let rem = 0;
          for (const f of allFeeders())
            if (feederMatches(f.name, e.feeder)) {
              const before = f.items.length;
              f.items = f.items.filter((it) => !itemMatches(it, e.item));
              rem += before - f.items.length;
            }
          if (rem) {
            changed = true;
            summary.push(`removed ${rem} item(s) matching "${e.item}"`);
          }
          break;
        }
        case 'setItemQuantity':
        case 'setItemDiscount': {
          if (!e.item || e.value == null) break;
          let c = 0;
          for (const f of allFeeders())
            if (feederMatches(f.name, e.feeder))
              for (const it of f.items)
                if (itemMatches(it, e.item)) {
                  if (e.op === 'setItemQuantity') it.qty = Math.max(1, Math.round(Number(e.value)));
                  else it.discountPct = clampPct(e.value);
                  c++;
                }
          if (c) {
            changed = true;
            summary.push(
              e.op === 'setItemQuantity'
                ? `set qty ${Math.round(Number(e.value))} on "${e.item}"`
                : `set ${clampPct(e.value)}% discount on "${e.item}"`,
            );
          }
          break;
        }
        case 'addProduct': {
          const query = (e.query ?? e.item ?? '').trim();
          if (!query) break;
          const resolved = resolveProduct(await getPool(), query, quote.brand, e.qty ?? 1, e.discount ?? 0);
          if (!resolved) {
            failed.push(
              `"${query}" — no confident match in the ${quote.brand ?? 'brand'} price list (add a rating/poles, e.g. "${query} 250A 4P")`,
            );
            break;
          }
          let targets = allFeeders().filter((f) => feederMatches(f.name, e.feeder));
          // If the named feeder doesn't exist yet, create it rather than failing.
          if (!targets.length) {
            const created: BomFeeder = { name: e.feeder?.trim() || 'New Feeder', feederQty: 1, items: [] };
            (nb[0] ?? nb[nb.length - 1])?.feeders.push(created);
            targets = [created];
          }
          for (const f of targets) f.items.push({ ...resolved });
          changed = true;
          const priceNote = resolved.catalogPrice != null ? ` @₹${resolved.catalogPrice}` : '';
          summary.push(
            `added ${resolved.modelNo ?? query} (${(resolved.description ?? '').slice(0, 40)}${priceNote}) to ${targets.length > 1 ? `${targets.length} feeders` : `"${targets[0]?.name}"`}`,
          );
          break;
        }
        case 'addFeeder': {
          const seed = e.items ?? (e.query ? [{ query: e.query }] : []);
          const items: BomItem[] = [];
          for (const s of seed) {
            const resolved = resolveProduct(await getPool(), s.query, quote.brand, s.qty ?? 1, s.discount ?? 0);
            if (resolved) items.push(resolved);
            else failed.push(`"${s.query}" not found in the ${quote.brand ?? 'brand'} price list`);
          }
          const board = nb[0];
          if (board) {
            board.feeders.push({
              name: e.name?.trim() || e.query?.trim() || 'New Feeder',
              feederQty: Math.max(1, Math.round(Number(e.qty ?? 1))),
              items,
            });
            changed = true;
            summary.push(`added feeder "${e.name?.trim() || 'New Feeder'}" (${items.length} item(s))`);
          }
          break;
        }
        default:
          break;
      }
    }
    if (changed)
      await prisma.quote.update({
        where: { id: quoteId },
        data: { bomJson: nb as unknown as Prisma.InputJsonValue },
      });
  } else {
    // Flat-format quotes: edit the stored lines.
    const byLine = new Map(quote.lines.map((l) => [l.lineNo, l]));
    for (const e of edits) {
      if (e.op === 'setDiscountAll' && e.value != null) {
        const disc = clampPct(e.value);
        for (const l of quote.lines) {
          const list = l.listPrice != null ? Number(l.listPrice) : null;
          const rate = list != null ? round2(list * (1 - disc / 100)) : null;
          await prisma.quoteLine.update({
            where: { id: l.id },
            data: { discountPct: disc, rate, amount: rate != null ? round2(rate * l.quantity) : null },
          });
        }
        changed = true;
        summary.push(`applied ${disc}% discount to all lines`);
        continue;
      }
      const l = e.lineNo != null ? byLine.get(e.lineNo) : undefined;
      if (!l) continue;
      if (e.op === 'removeLine') {
        await prisma.quoteLine.delete({ where: { id: l.id } });
        changed = true;
        summary.push(`removed line ${e.lineNo}`);
      } else if (e.op === 'setQuantity' && e.value != null) {
        const qty = Math.max(0, Math.round(Number(e.value)));
        const rate = l.rate != null ? Number(l.rate) : null;
        await prisma.quoteLine.update({
          where: { id: l.id },
          data: { quantity: qty, amount: rate != null ? round2(rate * qty) : null },
        });
        changed = true;
        summary.push(`set line ${e.lineNo} quantity to ${qty}`);
      } else if (e.op === 'setDiscount' && e.value != null) {
        const disc = clampPct(e.value);
        const list = l.listPrice != null ? Number(l.listPrice) : null;
        const rate = list != null ? round2(list * (1 - disc / 100)) : null;
        await prisma.quoteLine.update({
          where: { id: l.id },
          data: { discountPct: disc, rate, amount: rate != null ? round2(rate * l.quantity) : null },
        });
        changed = true;
        summary.push(`set line ${e.lineNo} discount to ${disc}%`);
      }
    }
  }

  const dl = fileName ? safeName(fileName) : null;
  if (dl) {
    await prisma.quote.update({ where: { id: quoteId }, data: { downloadName: dl } });
    changed = true;
    summary.push(`renamed the file to "${dl}.xlsx"`);
  }

  // Honest reply — never claim a change that didn't happen; report failures too.
  const problemNote = problems.length ? ` I couldn't: ${problems.join('; ')}.` : '';
  let finalReply: string;
  if (changed) {
    finalReply = `Updated the quote — ${summary.join('; ')}. The updated Excel is ready to download.${problemNote}`;
  } else if (problems.length) {
    finalReply = `I wasn't able to make that change.${problemNote}`;
  } else if (edits.length || fileName) {
    finalReply =
      reply ||
      "I couldn't apply that change. I can add or remove products (looked up in the price list), change quantities or discounts, add or remove feeders, limit the quote to one series, or rename the file.";
  } else {
    finalReply = reply || 'Okay.';
  }

  const assistant = await prisma.quoteMessage.create({
    data: { quoteId, role: 'ASSISTANT', content: finalReply },
  });
  return { ...assistant, quoteChanged: changed };
}

export async function deleteQuote(id: number) {
  await prisma.quote.delete({ where: { id } });
}
