/**
 * "Knowledge in Claude" training for brand files.
 *
 * Training a file = reading its text (transiently — the text is NOT stored in
 * our tables) and uploading it to Anthropic's Files API. We keep only the file
 * id Anthropic returns. At quote time the ids of the brand's trained files are
 * sent with the request and Claude reads the price lists itself.
 */
import { prisma } from '../../lib/prisma';
import { HttpError } from '../../lib/http-error';
import { getEffectiveLlmConfig } from '../../lib/llm';
import { PDFDocument } from 'pdf-lib';
import { readFile } from 'fs/promises';
import {
  PDF_MAX_PAGES_PER_REQUEST,
  deleteKnowledgeFile,
  explainAnthropicError,
  uploadKnowledgeText,
  type AnthropicAuth,
} from '../../lib/llm/anthropic-files';
import { readDocumentText, readPdfTextWithOcr } from '../price-list/price-list.text';
import { isPdf } from '../price-list/price-list.ai';

/** The name the file carries inside Claude: "<brand> — <label> (<file>).txt". */
function knowledgeFileName(brand: string, label: string | null, fileName: string): string {
  const base = `${brand} — ${label || fileName.replace(/\.[^.]+$/, '')}`
    .replace(/[^\w\s.\-—()]+/g, '')
    .trim()
    .slice(0, 120);
  return `${base}.txt`;
}

/** Anthropic key (+ workspace) from the effective config, or a clear error. */
async function anthropicKey(): Promise<AnthropicAuth> {
  const cfg = await getEffectiveLlmConfig();
  if (!cfg.anthropicApiKey) {
    throw HttpError.badRequest('Add an Anthropic API key in Settings → API Keys to train files into Claude.');
  }
  return { apiKey: cfg.anthropicApiKey, workspaceId: cfg.anthropicWorkspaceId || undefined };
}

/** Jobs run one at a time so a brand with many files doesn't flood the API. */
let queue: Promise<void> = Promise.resolve();

/** Resolves when every queued training job has finished (used by scripts/tests). */
export function whenTrainingIdle(): Promise<void> {
  return queue;
}

/**
 * Train one brand file into Claude in the background. aiStatus goes
 * PROCESSING → COMPLETED (with the file id) or FAILED (with the reason).
 */
export async function startClaudeTraining(documentId: number): Promise<void> {
  await anthropicKey(); // fail fast, before marking anything
  await prisma.productDocument.update({
    where: { id: documentId },
    data: { aiStatus: 'PROCESSING', aiError: null },
  });
  queue = queue.then(() => runClaudeTraining(documentId)).catch(() => undefined);
}

/**
 * Train one file as TEXT — all of it. For a PDF the bundled Python script gives
 * the text layer of every page PLUS local OCR of picture-only pages and of the
 * images embedded on text pages (graphic tables, labels), so nothing printed is
 * missed; the PDF itself (and its pictures) is never uploaded. Text is not bound
 * by Anthropic's PDF page limits. If Python is unavailable the text layer alone
 * is used (a pure scan then goes through the AI transcription as elsewhere).
 */
async function runClaudeTraining(documentId: number): Promise<void> {
  const doc = await prisma.productDocument.findUnique({ where: { id: documentId } });
  if (!doc) return;
  try {
    const auth = await anthropicKey();
    const src = { fileName: doc.fileName, mimeType: doc.mimeType, path: doc.storagePath };
    let pages = isPdf(doc.mimeType, doc.fileName)
      ? (await PDFDocument.load(await readFile(doc.storagePath), { ignoreEncryption: true })).getPageCount()
      : null;

    const ocr = await readPdfTextWithOcr(src);
    const text = ocr?.text ?? (await readDocumentText(src)).text;
    if (ocr) pages = ocr.pages;
    if (!text.trim()) throw new Error('No readable text was found in this file.');

    const header =
      `BRAND: ${doc.brand ?? ''}\nFILE: ${doc.name || doc.fileName} (${doc.fileName})\n` +
      "This is the complete text of the brand's price list / reference file" +
      (ocr && (ocr.ocrPages || ocr.ocrImages)
        ? ` (text layer of every page; ${ocr.ocrPages} picture page(s) and ${ocr.ocrImages} embedded image(s) transcribed by OCR, marked [ocr] / [image text])`
        : '') +
      '.\n\n';
    const uploaded = await uploadKnowledgeText(
      auth,
      knowledgeFileName(doc.brand ?? 'brand', doc.name, doc.fileName),
      header + text,
    );

    // Replace, never accumulate: previous versions (text or PDF) leave Anthropic.
    for (const old of [doc.aiFileId, doc.aiTextFileId]) {
      if (old && old !== uploaded.id) await deleteKnowledgeFile(auth, old).catch(() => undefined);
    }
    await prisma.productDocument.update({
      where: { id: documentId },
      data: {
        aiFileId: uploaded.id,
        aiTextFileId: null,
        aiFileKind: 'text',
        aiPages: pages,
        aiStatus: 'COMPLETED',
        aiError: null,
        aiFileChars: text.length,
        aiTrainedAt: new Date(),
      },
    });
  } catch (err) {
    await prisma.productDocument.update({
      where: { id: documentId },
      data: { aiStatus: 'FAILED', aiError: explainAnthropicError(err).slice(0, 2000) },
    });
  }
}

/** Train every "Train"-ticked file of a brand into Claude. */
export async function trainBrandIntoClaude(companyId: number): Promise<number> {
  const docs = await prisma.productDocument.findMany({
    where: { companyId, kind: 'PRICE_LIST', train: true },
    select: { id: true },
  });
  for (const d of docs) await startClaudeTraining(d.id);
  return docs.length;
}

/** Remove a file's copy from Anthropic (when the file is deleted or untrained). */
export async function forgetClaudeFile(documentId: number): Promise<void> {
  const doc = await prisma.productDocument.findUnique({
    where: { id: documentId },
    select: { aiFileId: true, aiTextFileId: true },
  });
  if (!doc?.aiFileId && !doc?.aiTextFileId) return;
  const cfg = await getEffectiveLlmConfig();
  if (cfg.anthropicApiKey) {
    const auth = { apiKey: cfg.anthropicApiKey, workspaceId: cfg.anthropicWorkspaceId || undefined };
    for (const id of [doc.aiFileId, doc.aiTextFileId]) {
      if (id) await deleteKnowledgeFile(auth, id).catch(() => undefined);
    }
  }
  await prisma.productDocument.update({
    where: { id: documentId },
    data: {
      aiFileId: null,
      aiTextFileId: null,
      aiFileKind: null,
      aiPages: null,
      aiStatus: 'NOT_STARTED',
      aiTrainedAt: null,
      aiFileChars: null,
    },
  });
}

/** Files trained into Claude for the given brands — what a quote request attaches. */
export async function knowledgeFilesForBrands(brands: string[]) {
  if (!brands.length) return [];
  const docs = await prisma.productDocument.findMany({
    // A file being re-trained still has its previous copy in Claude — keep using it
    // until the new one replaces it, so quotes never lose a brand file mid-training.
    where: {
      brand: { in: brands },
      kind: 'PRICE_LIST',
      train: true,
      aiStatus: { in: ['COMPLETED', 'PROCESSING'] },
      aiFileId: { not: null },
    },
    select: {
      id: true,
      brand: true,
      name: true,
      fileName: true,
      aiFileId: true,
      aiTextFileId: true,
      aiFileKind: true,
      aiPages: true,
      mimeType: true,
      storagePath: true,
      updatedAt: true,
    },
    orderBy: { id: 'asc' },
  });
  return docs.map((d) => ({ ...d, aiFileId: d.aiFileId! }));
}

/**
 * The file ids to attach for a request. PDFs are attached as PDFs while the
 * request stays within Anthropic's 100-page cap (smallest first, so as many as
 * possible fit); a PDF that would exceed it falls back to its text file.
 */
export function selectKnowledgeFileIds(
  docs: Awaited<ReturnType<typeof knowledgeFilesForBrands>>,
): { fileIds: string[]; pdfPages: number } {
  const ids: string[] = [];
  let pages = 0;
  const pdfs = docs.filter((d) => d.aiFileKind === 'pdf').sort((a, b) => (a.aiPages ?? 0) - (b.aiPages ?? 0));
  const texts = docs.filter((d) => d.aiFileKind !== 'pdf');
  for (const d of pdfs) {
    const p = d.aiPages ?? PDF_MAX_PAGES_PER_REQUEST;
    if (pages + p <= PDF_MAX_PAGES_PER_REQUEST) {
      ids.push(d.aiFileId);
      pages += p;
    } else if (d.aiTextFileId) {
      ids.push(d.aiTextFileId);
    }
  }
  for (const d of texts) ids.push(d.aiFileId);
  return { fileIds: ids, pdfPages: pages };
}

// ---------- Brand rules in Claude ----------

/**
 * Train one brand rule into Claude: its text becomes a small file with its own
 * id, attached to every quote that selects the rule. Runs in the background.
 */
export async function startRuleTraining(promptId: number): Promise<void> {
  await anthropicKey();
  await prisma.brandPrompt.update({
    where: { id: promptId },
    data: { aiStatus: 'PROCESSING', aiError: null },
  });
  queue = queue.then(() => runRuleTraining(promptId)).catch(() => undefined);
}

async function runRuleTraining(promptId: number): Promise<void> {
  const rule = await prisma.brandPrompt.findUnique({
    where: { id: promptId },
    include: { company: { select: { name: true } } },
  });
  if (!rule) return;
  try {
    const apiKey = await anthropicKey();
    const text = rule.content.trim();
    if (!text) throw new Error('The rule is empty.');
    const brand = rule.company.name;
    const title = rule.name.trim() || `Rule ${rule.id}`;
    const body = `BRAND: ${brand}\nRULE: ${title}\n\n${text}\n`;
    const uploaded = await uploadKnowledgeText(apiKey, knowledgeFileName(brand, `Rule — ${title}`, `rule-${rule.id}`), body);
    if (rule.aiFileId && rule.aiFileId !== uploaded.id) {
      await deleteKnowledgeFile(apiKey, rule.aiFileId).catch(() => undefined);
    }
    await prisma.brandPrompt.update({
      where: { id: promptId },
      data: { aiFileId: uploaded.id, aiStatus: 'COMPLETED', aiError: null, aiTrainedAt: new Date() },
    });
  } catch (err) {
    await prisma.brandPrompt.update({
      where: { id: promptId },
      data: { aiStatus: 'FAILED', aiError: explainAnthropicError(err).slice(0, 2000) },
    });
  }
}

/** Train every rule of a brand into Claude. */
export async function trainBrandRulesIntoClaude(companyId: number): Promise<number> {
  const rules = await prisma.brandPrompt.findMany({ where: { companyId }, select: { id: true } });
  for (const r of rules) await startRuleTraining(r.id);
  return rules.length;
}

/** Remove rules' copies from Anthropic (before the rules are deleted). */
export async function forgetRuleFiles(promptIds: number[]): Promise<void> {
  if (!promptIds.length) return;
  const rules = await prisma.brandPrompt.findMany({
    where: { id: { in: promptIds }, aiFileId: { not: null } },
    select: { aiFileId: true },
  });
  if (!rules.length) return;
  const cfg = await getEffectiveLlmConfig();
  if (!cfg.anthropicApiKey) return;
  const auth: AnthropicAuth = { apiKey: cfg.anthropicApiKey, workspaceId: cfg.anthropicWorkspaceId || undefined };
  for (const r of rules) await deleteKnowledgeFile(auth, r.aiFileId!).catch(() => undefined);
}

/**
 * The rules a quote applies, as Claude receives them: the file ids of the rules
 * trained into Claude, plus the text of any selected rule that is not (yet)
 * trained — so an edited-but-untrained rule still reaches the quote, in its
 * current wording. `promptIds` = the rules ticked for the chat; null = Common.
 */
export async function knowledgeRulesForQuote(brands: string[], promptIds: number[] | null) {
  if (!brands.length) return { fileIds: [] as string[], inlineText: '', names: [] as string[] };
  const rules = await prisma.brandPrompt.findMany({
    where: {
      company: { name: { in: brands } },
      ...(promptIds ? { id: { in: promptIds } } : { train: true }),
    },
    select: { id: true, name: true, content: true, aiFileId: true, aiStatus: true, company: { select: { name: true } } },
    orderBy: [{ companyId: 'asc' }, { id: 'asc' }],
  });
  const fileIds: string[] = [];
  const inline: string[] = [];
  const names: string[] = [];
  for (const r of rules) {
    const title = r.name.trim() || `Rule ${r.id}`;
    names.push(`${r.company.name} · ${title}`);
    if (r.aiStatus === 'COMPLETED' && r.aiFileId) fileIds.push(r.aiFileId);
    else if (r.content.trim()) inline.push(`Brand "${r.company.name}" — ${title}:\n${r.content.trim()}`);
  }
  return { fileIds, inlineText: inline.join('\n\n'), names };
}

/** Mark files / rules whose training was interrupted by a restart as failed (boot). */
export async function failInterruptedClaudeTraining(): Promise<void> {
  const note = 'Interrupted by a server restart — train again.';
  await Promise.all([
    prisma.productDocument.updateMany({ where: { aiStatus: 'PROCESSING' }, data: { aiStatus: 'FAILED', aiError: note } }),
    prisma.brandPrompt.updateMany({ where: { aiStatus: 'PROCESSING' }, data: { aiStatus: 'FAILED', aiError: note } }),
  ]);
}

/**
 * Transient brand text for verifying what Claude returned (codes and prices
 * must exist in the files). Read from the file on disk, kept in memory only.
 */
const textCache = new Map<number, { stamp: string; text: string }>();
export async function transientBrandText(
  docs: { id: number; fileName: string; mimeType: string; storagePath: string; updatedAt: Date }[],
): Promise<string> {
  const parts: string[] = [];
  for (const d of docs) {
    const stamp = d.updatedAt.toISOString();
    const hit = textCache.get(d.id);
    if (hit && hit.stamp === stamp) {
      parts.push(hit.text);
      continue;
    }
    const { text } = await readDocumentText({ fileName: d.fileName, mimeType: d.mimeType, path: d.storagePath }).catch(
      () => ({ text: '' }),
    );
    textCache.set(d.id, { stamp, text });
    parts.push(text);
  }
  return parts.join('\n');
}
