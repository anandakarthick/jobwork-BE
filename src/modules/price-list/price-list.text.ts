/**
 * Text extraction for uploaded brand files.
 *
 * Every file a brand uploads — trained or not — is read into plain text and
 * stored against the document (`product_document_texts`), so the brand's
 * material is available as text and not only as the original binary.
 *
 * Two steps, cheapest first:
 *   1. Read the file directly (free, instant): PDF text layer, Word, Excel/CSV,
 *      plain text.
 *   2. Only when that finds nothing — a scanned PDF or an image, which have no
 *      text layer — the configured AI provider reads the page images instead
 *      (OCR). This costs API credit, so it never runs for a file step 1 can read.
 *
 * Extraction runs in the background, one file at a time — parsing a large
 * catalogue PDF is memory-heavy, so several uploads are queued, not run at once.
 */
import fs from 'fs/promises';
import mammoth from 'mammoth';
import { PDFDocument } from 'pdf-lib';
import { prisma } from '../../lib/prisma';
import { HttpError } from '../../lib/http-error';
import { getLlmProvider, type LlmProvider } from '../../lib/llm';
import {
  imageMime,
  isDocx,
  isImage,
  isPdf,
  isSheet,
  pdfToText,
  sheetToText,
  withRetry,
} from './price-list.ai';

/** Max characters per stored chunk (kept well under the DB's per-row write limit). */
const CHUNK_CHARS = 200_000;

/** A PDF averaging fewer characters per page than this is treated as a scan. */
const SCAN_CHARS_PER_PAGE = 20;
/** Most pages of one scanned PDF the AI will read (each page is a paid request). */
const OCR_MAX_PAGES = 300;
const OCR_MAX_TOKENS = 8000;

const OCR_SYSTEM = [
  'You transcribe documents. Return ALL the text visible on the page or image,',
  'exactly as printed, in reading order.',
  '- Keep every number, code and symbol exactly; never correct, round or guess.',
  '- Tables: one table row per line, cells separated by " | ", header row first.',
  '- Do not summarise, translate, explain or add anything that is not on the page.',
  '- No markdown code fences. If the page has no text, return nothing.',
].join('\n');

interface DocSource {
  fileName: string;
  mimeType: string;
  path: string;
}

/** `[page N]` heads each page of a PDF's text. */
const PAGE_MARK = /^\[page \d+\]$/gm;

/** Step 1 — read the file directly, choosing the reader by its type. */
async function readLocalText(src: DocSource): Promise<string> {
  const { mimeType: m, fileName: n, path } = src;
  if (isPdf(m, n)) return pdfToText(path);
  if (isDocx(m, n)) return (await mammoth.extractRawText({ path })).value;
  if (isSheet(m, n)) return sheetToText(path);
  if (isImage(m, n)) return ''; // no text layer
  return fs.readFile(path, 'utf8');
}

/** True when direct reading found (almost) nothing and only OCR can read the file. */
function needsOcr(src: DocSource, text: string): boolean {
  if (isImage(src.mimeType, src.fileName)) return true;
  if (!isPdf(src.mimeType, src.fileName)) return false;
  const pages = (text.match(PAGE_MARK) ?? []).length;
  const body = text.replace(PAGE_MARK, '').replace(/\s+/g, '');
  return body.length < Math.max(1, pages) * SCAN_CHARS_PER_PAGE;
}

const stripFences = (s: string) => s.replace(/^```[a-z]*\n?/i, '').replace(/\n?```\s*$/i, '').trim();

/** Step 2 — have the AI provider read a scan: an image, or a PDF page by page. */
async function readTextWithAI(provider: LlmProvider, src: DocSource): Promise<string> {
  const opts = { system: OCR_SYSTEM, maxTokens: OCR_MAX_TOKENS, label: 'text:ocr' };

  if (isImage(src.mimeType, src.fileName)) {
    const dataBase64 = (await fs.readFile(src.path)).toString('base64');
    const raw = await withRetry(() =>
      provider.completeParts(
        [
          { type: 'text', text: 'Transcribe this image.' },
          { type: 'image', mimeType: imageMime(src.fileName, src.mimeType), dataBase64 },
        ],
        opts,
      ),
    );
    return stripFences(raw);
  }

  // Scanned PDF: send one page per request so every reply fits the output limit.
  const pdf = await PDFDocument.load(await fs.readFile(src.path), { ignoreEncryption: true });
  const total = pdf.getPageCount();
  if (total > OCR_MAX_PAGES) {
    throw new Error(
      `This scanned PDF has ${total} pages; reading with AI is limited to ${OCR_MAX_PAGES} pages per file. Split it into smaller files.`,
    );
  }
  const pages: string[] = [];
  for (let i = 0; i < total; i++) {
    const single = await PDFDocument.create();
    const [page] = await single.copyPages(pdf, [i]);
    single.addPage(page);
    const dataBase64 = Buffer.from(await single.save()).toString('base64');
    const raw = await withRetry(() =>
      provider.completeParts(
        [
          { type: 'text', text: 'Transcribe this page.' },
          { type: 'document', mimeType: 'application/pdf', dataBase64 },
        ],
        opts,
      ),
    );
    pages.push(`[page ${i + 1}]\n${stripFences(raw)}`);
  }
  return pages.join('\n\n');
}

/**
 * Complete PDF text via the bundled Python script (scripts/pdf_text.py): the text
 * layer of every page plus LOCAL OCR (RapidOCR) of picture-only pages and of the
 * images embedded on text pages — so a price list's graphic tables are trained
 * too, at no API cost. Returns null when Python / the libraries are unavailable
 * or the script fails, so callers can fall back to the plain text layer.
 */
export async function readPdfTextWithOcr(
  src: DocSource,
): Promise<{ text: string; pages: number; ocrPages: number; ocrImages: number } | null> {
  if (!isPdf(src.mimeType, src.fileName)) return null;
  const { spawn } = await import('child_process');
  const os = await import('os');
  const pathMod = await import('path');
  const script = pathMod.resolve(process.cwd(), 'scripts', 'pdf_text.py');
  const out = pathMod.join(os.tmpdir(), `jobwork-pdf-text-${process.pid}-${Date.now()}.txt`);
  const python = process.env.PYTHON_BIN || (process.platform === 'win32' ? 'py' : 'python3');
  const args = [...(python === 'py' ? ['-3'] : []), script, src.path, out];

  const summary = await new Promise<string | null>((resolve) => {
    let stdout = '';
    let stderr = '';
    const child = spawn(python, args, { windowsHide: true });
    child.stdout.on('data', (d) => (stdout += String(d)));
    child.stderr.on('data', (d) => (stderr += String(d)));
    child.on('error', () => resolve(null));
    child.on('close', (code) => {
      if (code !== 0) {
        console.warn('[pdf_text.py] failed:', stderr.trim().split('\n').slice(-3).join(' | '));
        resolve(null);
      } else resolve(stdout.trim().split('\n').pop() ?? null);
    });
  });
  if (!summary) return null;
  try {
    const stats = JSON.parse(summary) as { pages: number; ocrPages: number; ocrImages: number };
    const text = (await fs.readFile(out, 'utf8')).trim();
    await fs.rm(out, { force: true }).catch(() => undefined);
    if (!text) return null;
    return { text, pages: stats.pages, ocrPages: stats.ocrPages, ocrImages: stats.ocrImages };
  } catch {
    await fs.rm(out, { force: true }).catch(() => undefined);
    return null;
  }
}

/** Minimum characters for a PDF page to count as having a text layer. */
const BLANK_PAGE_CHARS = 40;

/**
 * Complete text of a PDF for training: the text layer, plus — for pages that
 * have none (picture-only pages, scanned tables) — the AI's transcription of
 * that page, so a mostly-text catalogue still contributes its image pages.
 * Non-PDFs and PDFs with a text layer on every page are returned as read.
 * `ocrPages` = how many pages the AI read (each one is a paid request).
 */
export async function readDocumentTextComplete(
  src: DocSource,
): Promise<{ text: string; source: 'FILE' | 'AI' | 'MIXED'; ocrPages: number }> {
  const base = await readDocumentText(src);
  if (base.source === 'AI' || !isPdf(src.mimeType, src.fileName)) return { ...base, ocrPages: 0 };

  // Split the text layer back into pages ("[page N]" marks) and find the blank ones.
  const parts = base.text.split(/^\[page (\d+)\]$/m);
  const pageText = new Map<number, string>();
  for (let i = 1; i < parts.length; i += 2) pageText.set(Number(parts[i]), (parts[i + 1] ?? '').trim());
  const pdf = await PDFDocument.load(await fs.readFile(src.path), { ignoreEncryption: true });
  const total = pdf.getPageCount();
  const blank: number[] = [];
  for (let p = 1; p <= total; p++) if ((pageText.get(p) ?? '').replace(/\s+/g, '').length < BLANK_PAGE_CHARS) blank.push(p);
  if (!blank.length || blank.length > OCR_MAX_PAGES) return { ...base, ocrPages: 0 };

  const provider = await getLlmProvider();
  if (provider.name === 'stub') return { ...base, ocrPages: 0 };
  const opts = { system: OCR_SYSTEM, maxTokens: OCR_MAX_TOKENS, label: 'text:ocr' };
  for (const p of blank) {
    const single = await PDFDocument.create();
    const [page] = await single.copyPages(pdf, [p - 1]);
    single.addPage(page);
    const dataBase64 = Buffer.from(await single.save()).toString('base64');
    const raw = await withRetry(() =>
      provider.completeParts(
        [
          { type: 'text', text: 'Transcribe this page.' },
          { type: 'document', mimeType: 'application/pdf', dataBase64 },
        ],
        opts,
      ),
    ).catch(() => '');
    const read = stripFences(raw);
    if (read) pageText.set(p, read);
  }
  const text = [...Array(total).keys()]
    .map((i) => `[page ${i + 1}]\n${pageText.get(i + 1) ?? ''}`)
    .join('\n\n')
    .trim();
  return { text, source: 'MIXED', ocrPages: blank.length };
}

/**
 * Read one file to plain text: directly when it has text, else with the AI
 * provider. `source` says which ("FILE" is free, "AI" spent API credit).
 */
export async function readDocumentText(
  src: DocSource,
): Promise<{ text: string; source: 'FILE' | 'AI' }> {
  const local = (await readLocalText(src)).trim();
  if (!needsOcr(src, local)) return { text: local, source: 'FILE' };

  const provider = await getLlmProvider();
  if (provider.name === 'stub') {
    throw new Error(
      'This file is a scan or an image, so it has no text to read directly. Add an OpenAI or ' +
        'Claude API key in Settings → API Keys, then save the brand again to read it with AI.',
    );
  }
  return { text: (await readTextWithAI(provider, src)).trim(), source: 'AI' };
}

/**
 * Split text into ≤CHUNK_CHARS pieces on line boundaries (chunks are re-joined
 * with a newline when read back). Only a single line longer than a whole chunk
 * is cut mid-line.
 */
function chunkText(text: string): string[] {
  const chunks: string[] = [];
  let cur = '';
  const flush = () => {
    if (cur) chunks.push(cur);
    cur = '';
  };
  for (const line of text.split('\n')) {
    if (line.length > CHUNK_CHARS) {
      flush();
      for (let i = 0; i < line.length; i += CHUNK_CHARS) chunks.push(line.slice(i, i + CHUNK_CHARS));
      continue;
    }
    if (cur && cur.length + line.length + 1 > CHUNK_CHARS) flush();
    cur += (cur ? '\n' : '') + line;
  }
  flush();
  return chunks;
}

// One extraction at a time: each job is chained onto the previous one.
let queue: Promise<void> = Promise.resolve();

/**
 * Mark a document as being read and queue its text extraction. Returns as soon
 * as the status is set; the client polls `textStatus` for the result.
 */
export async function startTextExtraction(documentId: number): Promise<void> {
  await prisma.productDocument.update({
    where: { id: documentId },
    data: { textStatus: 'PROCESSING', textError: null },
  });
  queue = queue.then(() => runTextJob(documentId));
}

/** The actual read → store work. Updates textStatus to COMPLETED/FAILED. */
async function runTextJob(documentId: number): Promise<void> {
  try {
    const doc = await prisma.productDocument.findUnique({
      where: { id: documentId },
      select: { fileName: true, mimeType: true, storagePath: true },
    });
    if (!doc) return; // deleted while queued

    const { text, source } = await readDocumentText({
      fileName: doc.fileName,
      mimeType: doc.mimeType,
      path: doc.storagePath,
    });

    // Chunks are written one statement each (small transactions), so the status
    // only flips to COMPLETED once every chunk is in.
    await prisma.productDocumentText.deleteMany({ where: { documentId } });
    for (const [seq, chunk] of chunkText(text).entries()) {
      await prisma.productDocumentText.create({ data: { documentId, seq, text: chunk } });
    }
    await prisma.productDocument.update({
      where: { id: documentId },
      data: { textStatus: 'COMPLETED', textChars: text.length, textSource: source, textError: null },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Could not read the file';
    await prisma.productDocument
      .update({
        where: { id: documentId },
        data: { textStatus: 'FAILED', textError: message.slice(0, 2000) },
      })
      .catch(() => {
        /* the document was deleted meanwhile */
      });
  }
}

/** The stored text of a document, chunks joined in order. */
export async function getDocumentText(documentId: number): Promise<string> {
  const doc = await prisma.productDocument.findUnique({
    where: { id: documentId },
    select: { textStatus: true },
  });
  if (!doc) throw HttpError.notFound('Document not found');
  if (doc.textStatus !== 'COMPLETED')
    throw HttpError.badRequest('The text of this file has not been extracted yet');
  const chunks = await prisma.productDocumentText.findMany({
    where: { documentId },
    orderBy: { seq: 'asc' },
    select: { text: true },
  });
  return chunks.map((c) => c.text).join('\n');
}

// ---------------------------------------------------------------------------
// Reference lookup for the quote chat
// ---------------------------------------------------------------------------

/** Characters per lookup window — about a paragraph or a few table rows. */
const WINDOW_CHARS = 500;
/** Cap on the excerpt text handed to the model per chat turn. */
const SNIPPET_BUDGET_CHARS = 6000;

export interface ReferenceSnippet {
  file: string;
  text: string;
}

/**
 * Find the passages of the given brands' reference files that best match a
 * message. The stored text of every file (trained or not, as long as it has
 * text) is cut into ~500-character windows on line boundaries; each window is
 * scored by how many distinct words of the query it contains, and the best
 * ones are returned within a fixed character budget. Plain keyword matching —
 * no AI call, so it costs nothing per message.
 */
export async function retrieveReferenceSnippets(
  brands: string[],
  query: string,
  limit = 8,
  maxChars = SNIPPET_BUDGET_CHARS,
): Promise<ReferenceSnippet[]> {
  const words = [...new Set(query.toLowerCase().split(/[^a-z0-9.\/-]+/i).filter((w) => w.length > 1))];
  if (!brands.length || !words.length) return [];

  const docs = await prisma.productDocument.findMany({
    where: { company: { name: { in: brands } }, textStatus: 'COMPLETED', textChars: { gt: 0 } },
    select: { id: true, name: true, fileName: true, textChunks: { orderBy: { seq: 'asc' }, select: { text: true } } },
  });

  const scored: { file: string; text: string; score: number }[] = [];
  for (const d of docs) {
    const file = d.name || d.fileName;
    const text = d.textChunks.map((c) => c.text).join('\n');
    let cur = '';
    const consider = (window: string) => {
      const hay = window.toLowerCase();
      let score = 0;
      for (const w of words) if (hay.includes(w)) score++;
      if (score > 0) scored.push({ file, text: window.trim(), score });
    };
    for (const line of text.split('\n')) {
      if (cur && cur.length + line.length + 1 > WINDOW_CHARS) {
        consider(cur);
        cur = '';
      }
      cur += (cur ? '\n' : '') + line;
    }
    if (cur) consider(cur);
  }

  scored.sort((a, b) => b.score - a.score);
  const out: ReferenceSnippet[] = [];
  let used = 0;
  for (const s of scored) {
    if (out.length >= limit || used + s.text.length > maxChars) break;
    out.push({ file: s.file, text: s.text });
    used += s.text.length;
  }
  return out;
}

/**
 * Extraction jobs live in this process, so a restart loses any that were
 * running or queued. Called at boot: mark those as failed so saving the brand
 * again retries them instead of leaving them "extracting…" forever.
 */
export async function failInterruptedTextJobs(): Promise<void> {
  await prisma.productDocument.updateMany({
    where: { textStatus: 'PROCESSING' },
    data: { textStatus: 'FAILED', textError: 'Interrupted by a server restart — save the brand again to retry.' },
  });
}
