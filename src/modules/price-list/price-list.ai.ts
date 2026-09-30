/**
 * AI-based price-list extraction (multi-format).
 *
 * Reads a price-list document in ANY common format — PDF, image (scan/photo),
 * Word (.docx), or Excel/CSV — and asks the configured LLM to return the priced
 * catalogue rows as structured JSON, which the ingest flow stores into
 * `price_list_items`.
 *
 * Large documents are split into chunks and sent as several small requests,
 * paced to stay under the account's tokens-per-minute (TPM) rate limit, then
 * merged and de-duplicated by catalog number. Formats are prepared locally:
 *   - Excel/CSV/TXT → text
 *   - Word (.docx)  → text (mammoth)
 *   - PDF           → Claude reads it natively; for OpenAI we send extracted text
 *   - Image         → sent to the model as an inline image (vision)
 */
import fs from 'fs/promises';
import * as XLSX from 'xlsx';
import mammoth from 'mammoth';
import { z } from 'zod';
import { HttpError } from '../../lib/http-error';
import type { LlmContentPart, LlmProvider } from '../../lib/llm';
import { extractPages } from '../../lib/pdf/extract-rows';
import type { ParsedItem } from './price-list.parser';

export interface IngestSource {
  fileName: string;
  mimeType: string;
  path: string;
}

// ---- Rate-limit tuning (kept well under a 30k TPM tier-1 OpenAI limit) -------
// Chunks are small so a chunk's items comfortably fit the output budget (no
// truncated JSON); a chunk that still comes back empty is split and retried.
const CHARS_PER_CHUNK = 9000; // ~2.3k input tokens per request
const OUTPUT_MAX = 8000; // output token budget per request (fits ~100 items)
const TPM_BUDGET = 27000; // stay under 30k/min, leaving headroom
const estTokens = (s: string) => Math.ceil(s.length / 4);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const EXTRACT_SYSTEM = [
  'You are a data-extraction engine for electrical switchgear price lists.',
  'From the supplied document (which may be one part of a larger price list),',
  'extract EVERY priced catalogue line item you can see.',
  'Return ONLY a JSON object of the form {"items": Item[]} where Item is:',
  '{',
  '  "catalogNo": string,            // the product/catalog/order number (required)',
  '  "description": string,          // short human description of the item',
  '  "family": string|null,          // product family/series if shown',
  '  "type": string|null,            // type/model group if shown',
  '  "poles": number|null,           // number of poles (1-4) if applicable',
  '  "ratingAmp": number|null,       // rated current in amps (single value)',
  '  "ratingAmpMin": number|null,    // low end if the row gives a range',
  '  "ratingAmpMax": number|null,    // high end if the row gives a range',
  '  "breakingKa": number|null,      // breaking capacity in kA if shown',
  '  "listPrice": number,            // unit list price / MRP as a number (required)',
  '  "unit": string|null             // pricing unit if shown (e.g. "per unit")',
  '}',
  'Rules:',
  '- Include a row ONLY if it has both a catalog number and a numeric price.',
  '- Strip currency symbols and thousands separators from listPrice (e.g. "₹1,09,800" → 109800).',
  '- Do not invent values; use null when a field is not present.',
  '- Do not include headings, notes, totals, or packaging quantities as items.',
  '- If this part contains no priced items, return {"items": []}.',
  '',
  'CONFIGURABLE PRODUCTS (matrix / build-a-catalog listings) — some entries are NOT a',
  'single priced row but a TEMPLATE: a base catalog number with placeholder digits',
  '(shown as □, X, *, dots, or blanks) plus side columns that map each attribute value',
  'to specific catalog digit(s) — e.g. "Colour (4th digit): R-Red, G-Green, B-Blue…",',
  '"Voltage (5th-8th digit): 240A-240 VAC, 415A-415 VAC…" — together with a small PRICE',
  'table that gives a DIFFERENT price per attribute tier (e.g. 185 for standard colours,',
  '318 for Blue & White, 232 at 415 VAC). For every such listing:',
  '  • EXPAND the template into ONE item per ORDERABLE combination. Build the real',
  '    catalog number by substituting the mapped digits into the placeholders (base',
  '    "EPL" + colour "R" + voltage "240A" → "EPLR240A"). Put the chosen attribute',
  '    values into the description ("Gen Next Pro LED Indicator Ø22.5 mm, Red, 240 VAC").',
  '  • Use the price the table gives for THAT exact combination — the standard tier for',
  '    standard values, the premium tier for the premium values (Blue/White → 318; a',
  '    415 VAC row → 232, or 392 if also Blue/White). Never apply one price to every',
  '    combination, and never emit the bare template row (e.g. "EPL" on its own).',
  '  • Enumerate every listed attribute value on each axis (all colours × all voltages,',
  '    all ratings, etc.); these are cheap rows and each must be independently matchable.',
  '  • This applies to ANY attribute the list configures by catalog digit — colour,',
  '    voltage, rating, mounting, contact configuration — not only the example above.',
].join('\n');

const ItemSchema = z.object({
  catalogNo: z.string().trim().min(1),
  description: z.string().trim().optional().default(''),
  family: z.string().trim().nullable().optional(),
  type: z.string().trim().nullable().optional(),
  poles: z.coerce.number().int().nullable().optional(),
  ratingAmp: z.coerce.number().nullable().optional(),
  ratingAmpMin: z.coerce.number().nullable().optional(),
  ratingAmpMax: z.coerce.number().nullable().optional(),
  breakingKa: z.coerce.number().nullable().optional(),
  listPrice: z.coerce.number().positive(),
  unit: z.string().trim().nullable().optional(),
});

export const isImage = (m: string, n: string) => /image\//i.test(m) || /\.(png|jpe?g|webp|gif)$/i.test(n);
export const isPdf = (m: string, n: string) => /pdf/i.test(m) || /\.pdf$/i.test(n);
export const isDocx = (m: string, n: string) => /wordprocessingml|msword/i.test(m) || /\.docx?$/i.test(n);
export const isSheet = (m: string, n: string) => /sheet|excel|csv/i.test(m) || /\.(xlsx|xls|csv)$/i.test(n);

export function imageMime(name: string, mime: string): string {
  if (/image\/(png|jpeg|webp|gif)/i.test(mime)) return mime.toLowerCase();
  if (/\.png$/i.test(name)) return 'image/png';
  if (/\.(jpe?g)$/i.test(name)) return 'image/jpeg';
  if (/\.webp$/i.test(name)) return 'image/webp';
  if (/\.gif$/i.test(name)) return 'image/gif';
  return 'image/png';
}

export async function sheetToText(path: string): Promise<string> {
  const buf = await fs.readFile(path);
  const wb = XLSX.read(buf, { type: 'buffer' });
  return wb.SheetNames.map((n) => `# ${n}\n${XLSX.utils.sheet_to_csv(wb.Sheets[n]!)}`).join('\n\n');
}

export async function pdfToText(path: string): Promise<string> {
  const data = new Uint8Array(await fs.readFile(path));
  const pages = await extractPages(data);
  return pages.map((p) => `[page ${p.pageNo}]\n${p.rows.map((r) => r.text).join('\n')}`).join('\n\n');
}

/** Split text into ≤CHARS_PER_CHUNK pieces on line boundaries (rows stay whole). */
function chunkText(text: string): string[] {
  const lines = text.split('\n');
  const chunks: string[] = [];
  let cur = '';
  for (const line of lines) {
    if (cur.length + line.length + 1 > CHARS_PER_CHUNK && cur) {
      chunks.push(cur);
      cur = '';
    }
    cur += (cur ? '\n' : '') + line;
  }
  if (cur.trim()) chunks.push(cur);
  return chunks.length ? chunks : [text];
}

/** Simple rolling-minute token pacer so we never trip the TPM rate limit. */
function makePacer(budgetPerMin = TPM_BUDGET) {
  let events: { t: number; tokens: number }[] = [];
  return async function pace(tokens: number): Promise<void> {
    for (;;) {
      const now = Date.now();
      events = events.filter((e) => now - e.t < 60_000);
      const used = events.reduce((s, e) => s + e.tokens, 0);
      if (events.length === 0 || used + tokens <= budgetPerMin) {
        events.push({ t: now, tokens });
        return;
      }
      const waitMs = 60_000 - (now - events[0]!.t) + 300;
      await sleep(Math.min(Math.max(waitMs, 500), 60_000));
    }
  };
}

/** Run `fn`, retrying on transient rate-limit (429) errors with backoff. */
export async function withRetry<T>(fn: () => Promise<T>, tries = 4): Promise<T> {
  let delay = 8000;
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const rateLimited = /\b429\b|rate limit|tokens per min|\bTPM\b/i.test(msg);
      if (!rateLimited || attempt >= tries) throw err;
      await sleep(delay);
      delay = Math.min(delay * 2, 60_000);
    }
  }
}

/** Parse one model response into items; returns [] on unreadable/empty output. */
function parseChunk(raw: string): z.infer<typeof ItemSchema>[] {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    const m = /\{[\s\S]*\}/.exec(raw);
    if (!m) return [];
    try {
      json = JSON.parse(m[0]);
    } catch {
      return [];
    }
  }
  const arr = Array.isArray(json)
    ? json
    : Array.isArray((json as { items?: unknown }).items)
      ? (json as { items: unknown[] }).items
      : [];
  const out: z.infer<typeof ItemSchema>[] = [];
  for (const row of arr) {
    const p = ItemSchema.safeParse(row);
    if (p.success) out.push(p.data);
  }
  return out;
}

function toParsedItem(d: z.infer<typeof ItemSchema>, brand: string): ParsedItem {
  return {
    catalogNo: d.catalogNo,
    family: d.family ?? null,
    type: d.type ?? null,
    poles: d.poles ?? null,
    ratingAmp: d.ratingAmp ?? d.ratingAmpMax ?? null,
    ratingAmpMin: d.ratingAmpMin ?? null,
    ratingAmpMax: d.ratingAmpMax ?? d.ratingAmp ?? null,
    breakingKa: d.breakingKa ?? null,
    listPrice: d.listPrice,
    unit: d.unit ?? null,
    description: d.description || `${brand} ${d.catalogNo}`.trim(),
    pageNo: null,
    rawText: null,
    attributes: null,
  };
}

/** Merge items from several chunks, de-duplicating by catalog number. */
function mergeItems(rows: z.infer<typeof ItemSchema>[], brand: string): ParsedItem[] {
  const byCatalog = new Map<string, ParsedItem>();
  for (const r of rows) {
    const key = r.catalogNo.trim().toUpperCase();
    if (!byCatalog.has(key)) byCatalog.set(key, toParsedItem(r, brand));
  }
  return [...byCatalog.values()];
}

type Pacer = (tokens: number) => Promise<void>;

/** Extract one chunk; if it comes back empty but clearly held priced rows,
 *  split it and retry (guards against output-truncation on dense chunks). */
async function extractChunk(
  provider: LlmProvider,
  chunk: string,
  brand: string,
  pace: Pacer,
  depth = 0,
): Promise<z.infer<typeof ItemSchema>[]> {
  const content = `Brand: ${brand}. This is one part of the price list.\n\n${chunk}`;
  await pace(estTokens(EXTRACT_SYSTEM) + estTokens(content) + OUTPUT_MAX);
  const raw = await withRetry(() =>
    provider.complete([{ role: 'user', content }], {
      system: EXTRACT_SYSTEM,
      json: true,
      maxTokens: OUTPUT_MAX,
      label: 'ingest:extract',
    }),
  );
  const rows = parseChunk(raw);
  if (rows.length === 0 && depth < 3 && chunk.length > 1500 && /\d{3,}/.test(chunk)) {
    // Likely truncated or too dense — halve on a line boundary and retry each.
    const lines = chunk.split('\n');
    const mid = Math.max(1, Math.floor(lines.length / 2));
    const a = lines.slice(0, mid).join('\n');
    const b = lines.slice(mid).join('\n');
    return [
      ...(await extractChunk(provider, a, brand, pace, depth + 1)),
      ...(await extractChunk(provider, b, brand, pace, depth + 1)),
    ];
  }
  return rows;
}

/** Chunk long text, extract each chunk (paced + retried), merge results. */
async function extractFromText(
  provider: LlmProvider,
  text: string,
  brand: string,
): Promise<z.infer<typeof ItemSchema>[]> {
  const chunks = chunkText(text);
  const pace = makePacer();
  const all: z.infer<typeof ItemSchema>[] = [];
  for (const chunk of chunks) {
    all.push(...(await extractChunk(provider, chunk, brand, pace)));
  }
  return all;
}

/**
 * Extract price-list items from a document of any supported format using AI.
 * Throws HttpError for unsupported formats or when nothing could be extracted.
 */
export async function extractItemsWithAI(
  provider: LlmProvider,
  src: IngestSource,
  brand: string,
): Promise<ParsedItem[]> {
  let rows: z.infer<typeof ItemSchema>[];

  if (isImage(src.mimeType, src.fileName)) {
    // One image → one vision request.
    const dataBase64 = (await fs.readFile(src.path)).toString('base64');
    const parts: LlmContentPart[] = [
      { type: 'text', text: `Brand: ${brand}. Extract the full price list from this image.` },
      { type: 'image', mimeType: imageMime(src.fileName, src.mimeType), dataBase64 },
    ];
    const raw = await withRetry(() =>
      provider.completeParts(parts, {
        system: EXTRACT_SYSTEM,
        json: true,
        maxTokens: 8000,
        label: 'ingest:extract',
      }),
    );
    rows = parseChunk(raw);
  } else if (isPdf(src.mimeType, src.fileName)) {
    if (provider.name === 'claude') {
      // Claude reads the PDF natively in a single request.
      const dataBase64 = (await fs.readFile(src.path)).toString('base64');
      const parts: LlmContentPart[] = [
        { type: 'text', text: `Brand: ${brand}. Extract the full price list from this PDF.` },
        { type: 'document', mimeType: 'application/pdf', dataBase64 },
      ];
      const raw = await withRetry(() =>
        provider.completeParts(parts, {
          system: EXTRACT_SYSTEM,
          json: true,
          maxTokens: 16000,
          label: 'ingest:extract',
        }),
      );
      rows = parseChunk(raw);
    } else {
      const text = await pdfToText(src.path);
      if (!text.trim())
        throw HttpError.badRequest(
          'This PDF has no extractable text (likely a scan). Upload it as an image, or use the Claude provider which reads PDFs directly.',
        );
      rows = await extractFromText(provider, text, brand);
    }
  } else {
    let text = '';
    if (isDocx(src.mimeType, src.fileName)) text = (await mammoth.extractRawText({ path: src.path })).value;
    else if (isSheet(src.mimeType, src.fileName)) text = await sheetToText(src.path);
    else if (/text\/|\.txt$/i.test(src.mimeType) || /\.txt$/i.test(src.fileName))
      text = (await fs.readFile(src.path)).toString('utf8');
    else
      throw HttpError.badRequest(
        `Unsupported file type "${src.mimeType || src.fileName}". Upload a PDF, image, Word, or Excel file.`,
      );
    if (!text.trim()) throw HttpError.badRequest('The document appears to be empty.');
    rows = await extractFromText(provider, text, brand);
  }

  const items = mergeItems(rows, brand);
  if (items.length === 0)
    throw HttpError.badRequest('No priced items could be extracted from this document.');
  return items;
}
