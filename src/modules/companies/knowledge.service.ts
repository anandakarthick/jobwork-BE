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
import { getEffectiveLlmConfig, getLlmProvider, type LlmProvider } from '../../lib/llm';
import { getPromptText } from '../prompts/prompt.service';
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

    // Read the price list ONCE more — by Claude — into a compact catalogue index,
    // one file per section. Quotes attach the sections a BOQ needs instead of the
    // whole text, which is what makes each quote cheap. The full text stays as the
    // fallback when a file has no index.
    try {
      const sections = await buildCatalogueIndex(documentId, text, auth);
      await prisma.productDocument.update({
        where: { id: documentId },
        data: { aiIndexedAt: sections ? new Date() : null, aiSectionCount: sections },
      });
    } catch (err) {
      console.warn('[knowledge] catalogue index failed for document', documentId, explainAnthropicError(err));
      await prisma.productDocument.update({
        where: { id: documentId },
        data: { aiIndexedAt: null, aiSectionCount: 0 },
      });
    }
  } catch (err) {
    await prisma.productDocument.update({
      where: { id: documentId },
      data: { aiStatus: 'FAILED', aiError: explainAnthropicError(err).slice(0, 2000) },
    });
  }
}

// ---------- Catalogue index (sections) ----------

/** Characters of price-list text per indexing request (≈ 15–20k tokens). */
const INDEX_CHUNK_CHARS = 60_000;

/** Strip ``` fences and parse a JSON value the model returned. */
function parseJson<T>(raw: string): T {
  const cleaned = raw.replace(/^```(?:json)?/i, '').replace(/```$/i, '').trim();
  const start = cleaned.search(/[[{]/);
  return JSON.parse(start > 0 ? cleaned.slice(start) : cleaned) as T;
}

/** Split the trained text into chunks on page boundaries, each ≤ max chars. */
function chunkByPages(text: string, max: number): string[] {
  const pages = text.split(/(?=^\[page \d+\]$)/m);
  const chunks: string[] = [];
  let cur = '';
  for (const p of pages) {
    if (cur && cur.length + p.length > max) {
      chunks.push(cur);
      cur = '';
    }
    if (p.length > max) {
      // A single huge page: cut it hard.
      for (let i = 0; i < p.length; i += max) chunks.push(p.slice(i, i + max));
      continue;
    }
    cur += p;
  }
  if (cur.trim()) chunks.push(cur);
  return chunks;
}

/**
 * Build the catalogue index of one trained file: Claude reads the text chunk by
 * chunk and returns products grouped by the price list's own sections; the
 * sections are merged across chunks, uploaded to Claude one file each, and their
 * ids kept. Returns the number of sections stored.
 */
async function buildCatalogueIndex(documentId: number, text: string, auth: AnthropicAuth): Promise<number> {
  const doc = await prisma.productDocument.findUnique({ where: { id: documentId } });
  if (!doc) return 0;
  const provider = await getLlmProvider();
  if (!provider.completeWithKnowledge) return 0;
  const system = await getPromptText('knowledge.index.system');
  const label = `${doc.brand ?? ''} — ${doc.name || doc.fileName}`;

  type Section = { name: string; keywords: Set<string>; lines: string[] };
  type RawSection = { name?: unknown; keywords?: unknown; lines?: unknown };
  const merged = new Map<string, Section>();
  const absorb = (sections: RawSection[]) => {
    for (const s of sections) {
      const name = String(s.name ?? '').trim().slice(0, 190);
      if (!name) continue;
      const key = name.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
      const entry = merged.get(key) ?? { name, keywords: new Set<string>(), lines: [] };
      if (Array.isArray(s.keywords)) for (const k of s.keywords) entry.keywords.add(String(k).toLowerCase().trim());
      if (Array.isArray(s.lines)) for (const l of s.lines) if (String(l).trim()) entry.lines.push(String(l).trim());
      merged.set(key, entry);
    }
  };
  // Index one chunk. A malformed answer (cut-off / bad JSON) is retried once and,
  // if still unusable, the chunk is split in half and each half indexed — a
  // smaller piece gives a shorter, safer answer. Below ~8k chars we give up on it.
  const indexChunk = async (chunk: string, part: string, attempt = 0): Promise<void> => {
    const raw = await provider.completeWithKnowledge!(
      { fileIds: [], messages: [{ role: 'user', content: `PRICE LIST: ${label} (${part})\n\n${chunk}` }] },
      { system, json: true, label: 'knowledge:index' },
    );
    try {
      absorb(parseJson<{ sections?: RawSection[] }>(raw).sections ?? []);
    } catch (err) {
      if (attempt === 0) return indexChunk(chunk, part, 1);
      if (chunk.length > 8_000) {
        const cut = chunk.lastIndexOf('\n[page ', Math.floor(chunk.length / 2));
        const at = cut > 1000 ? cut : Math.floor(chunk.length / 2);
        await indexChunk(chunk.slice(0, at), `${part}a`);
        await indexChunk(chunk.slice(at), `${part}b`);
        return;
      }
      console.warn('[knowledge] index chunk skipped:', part, err instanceof Error ? err.message : err);
    }
  };
  const chunks = chunkByPages(text, INDEX_CHUNK_CHARS);
  for (const [i, chunk] of chunks.entries()) await indexChunk(chunk, `part ${i + 1} of ${chunks.length}`);

  // Replace the previous index of this file (files in Claude + rows).
  const old = await prisma.knowledgeSection.findMany({ where: { documentId }, select: { aiFileId: true } });
  for (const id of new Set(old.map((o) => o.aiFileId))) await deleteKnowledgeFile(auth, id).catch(() => undefined);
  await prisma.knowledgeSection.deleteMany({ where: { documentId } });

  // Sections are the unit a BOQ PICKS; they are stored in Claude in BUNDLES of
  // neighbouring sections (≈ 60k chars each) so a quote attaches a handful of
  // files, not one per section — Anthropic counts every attached file as a fetch
  // and allows ~100 fetches a minute. Each section row carries its bundle's id.
  const BUNDLE_CHARS = 60_000;
  const prepared = [...merged.values()]
    .map((s) => {
      const lines = [...new Set(s.lines)];
      const text = `## SECTION: ${s.name}\n${lines.join('\n')}\n`;
      return { ...s, lines, text };
    })
    .filter((s) => s.lines.length);
  const header =
    `BRAND: ${doc.brand ?? ''}\nFILE: ${doc.name || doc.fileName}\n` +
    'Catalogue index — one product per line: catalogue number | description | price, grouped by section.\n\n';
  const bundles: (typeof prepared)[] = [];
  let cur: typeof prepared = [];
  let size = 0;
  for (const s of prepared) {
    if (cur.length && size + s.text.length > BUNDLE_CHARS) {
      bundles.push(cur);
      cur = [];
      size = 0;
    }
    cur.push(s);
    size += s.text.length;
  }
  if (cur.length) bundles.push(cur);

  let count = 0;
  for (const [i, bundle] of bundles.entries()) {
    const body = header + bundle.map((s) => s.text).join('\n');
    const uploaded = await uploadKnowledgeText(
      auth,
      knowledgeFileName(doc.brand ?? 'brand', `${doc.name || doc.fileName} — index ${i + 1} of ${bundles.length}`, doc.fileName),
      body,
    );
    for (const s of bundle) {
      await prisma.knowledgeSection.create({
        data: {
          documentId,
          name: s.name,
          keywords: [...s.keywords].filter(Boolean).join(', ').slice(0, 60_000),
          aiFileId: uploaded.id,
          chars: s.text.length,
          lineCount: s.lines.length,
        },
      });
      count++;
    }
  }
  return count;
}

export interface KnowledgeSectionInfo {
  id: number;
  documentId: number;
  brand: string;
  name: string;
  keywords: string;
  aiFileId: string;
  lineCount: number;
}

/** Every catalogue section of the brands' trained files. */
export async function knowledgeSectionsForBrands(brands: string[]): Promise<KnowledgeSectionInfo[]> {
  if (!brands.length) return [];
  const rows = await prisma.knowledgeSection.findMany({
    where: {
      document: { brand: { in: brands }, kind: 'PRICE_LIST', train: true, aiStatus: { in: ['COMPLETED', 'PROCESSING'] } },
    },
    include: { document: { select: { brand: true } } },
    orderBy: [{ documentId: 'asc' }, { id: 'asc' }],
  });
  return rows.map((r) => ({
    id: r.id,
    documentId: r.documentId,
    brand: r.document.brand ?? '',
    name: r.name,
    keywords: r.keywords,
    aiFileId: r.aiFileId,
    lineCount: r.lineCount,
  }));
}

/**
 * Ask the FAST model which sections a BOQ needs. Returns the chosen ids, or every
 * id when the pick fails or comes back empty — a missing section is the one
 * mistake that would hide products, so the fallback is "all".
 */
export async function selectSectionsForBoq(
  provider: LlmProvider,
  boqText: string,
  sections: KnowledgeSectionInfo[],
): Promise<{ ids: number[]; partial: boolean }> {
  const all = sections.map((s) => s.id);
  if (!provider.completeWithKnowledge || sections.length <= 2) return { ids: all, partial: false };
  try {
    const system = await getPromptText('knowledge.select.system');
    const list = sections
      .map((s) => `${s.id} | ${s.brand} | ${s.name} | ${s.lineCount} products | ${s.keywords.slice(0, 300)}`)
      .join('\n');
    const raw = await provider.completeWithKnowledge(
      {
        fileIds: [],
        messages: [{ role: 'user', content: `AVAILABLE SECTIONS (id | brand | name | size | keywords):\n${list}\n\nBOQ:\n${boqText.slice(0, 60_000)}` }],
      },
      { system, json: true, maxTokens: 2000, label: 'knowledge:select', tier: 'fast' },
    );
    const parsed = parseJson<{ sectionIds?: unknown }>(raw);
    let ids = Array.isArray(parsed.sectionIds)
      ? parsed.sectionIds.map((v) => Number(v)).filter((n) => all.includes(n))
      : [];
    if (!ids.length) return { ids: all, partial: false };
    // The model's pick varies a little run to run; union it with a plain word match
    // between the BOQ and the section names ("meter" in the BOQ → every *Meters*
    // section), then add each family's accessory sections. Recall over economy.
    ids = [...new Set([...ids, ...keywordSections(boqText, sections)])];
    ids = withCompanionSections(ids, sections);
    return { ids, partial: ids.length < all.length };
  } catch {
    return { ids: all, partial: false };
  }
}

/**
 * Words that occur in more than `share` of the given word lists — i.e. generic
 * for THIS catalogue ("range", "accessories", "switch", "led", "3 pole"…) —
 * learned from the brand's own sections at run time, never listed in code.
 */
function commonWords(lists: string[][], share: number): Set<string> {
  const df = new Map<string, number>();
  for (const l of lists) for (const w of new Set(l)) df.set(w, (df.get(w) ?? 0) + 1);
  const limit = Math.max(2, Math.ceil(lists.length * share));
  return new Set([...df.entries()].filter(([, n]) => n > limit).map(([w]) => w));
}

/**
 * Sections whose own KEYWORDS (written at indexing: product names, trade terms,
 * acronyms) occur in the BOQ text. Phrases are compared with spaces removed, so
 * "multi function meter" finds "multifunction meter"; short acronyms (MFM, ELR,
 * MCCB) must appear as upper-case words in the BOQ. Generic single words and bare
 * numbers / ratings are ignored.
 */
function keywordSections(boqText: string, sections: KnowledgeSectionInfo[]): number[] {
  const norm = boqText.toLowerCase().replace(/[^a-z0-9]+/g, ' ');
  const squashed = norm.replace(/ /g, '');
  const acronyms = new Set((boqText.match(/\b[A-Z][A-Z0-9]{2,5}\b/g) ?? []).map((a) => a.toLowerCase()));
  const phrases = (keywords: string) =>
    keywords
      .split(',')
      .map((raw) => raw.trim().toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim())
      .filter(Boolean);
  // A keyword shared by many sections of this catalogue ("led", "rs485", "3 pole")
  // cannot point at one of them — learned from the sections, not listed in code.
  const generic = commonWords(sections.map((s) => phrases(s.keywords)), 0.05);
  const phraseHits = (keywords: string): boolean => {
    for (const k of phrases(keywords)) {
      if (/^\d/.test(k) || generic.has(k)) continue; // numbers / ratings / catalogue-generic words
      const words = k.split(' ');
      if (words.length === 1) {
        // Single word: acronyms 3–5 chars must be upper-case in the BOQ; longer
        // words must be whole words in the BOQ.
        if (k.length <= 5) {
          if (acronyms.has(k)) return true;
        } else if (new RegExp(`\\b${k}s?\\b`).test(norm)) return true;
        continue;
      }
      const sq = k.replace(/ /g, '');
      if (sq.length >= 6 && squashed.includes(sq)) return true;
    }
    return false;
  };
  return sections.filter((s) => phraseHits(s.keywords)).map((s) => s.id);
}

/**
 * A device family's related sections always travel with it: if "DZ MCCB Range" is
 * picked, "Accessories for DZ MCCBs" is attached too, whatever the model said.
 * Nothing about accessories is written here — a section whose name contains
 * another section's distinctive name words belongs to the same family, where
 * "distinctive" = not common across this catalogue's section names.
 */
function withCompanionSections(ids: number[], sections: KnowledgeSectionInfo[]): number[] {
  const words = (name: string) =>
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, ' ')
      .split(' ')
      .filter((w) => w.length >= 2);
  const common = commonWords(sections.map((s) => words(s.name)), 0.15);
  const core = (name: string) => words(name).filter((w) => !common.has(w)).slice(0, 2);
  const chosen = new Set(ids);
  for (const id of ids) {
    const s = sections.find((x) => x.id === id);
    if (!s) continue;
    const c = core(s.name);
    if (c.length < 1) continue;
    for (const a of sections) {
      if (chosen.has(a.id) || a.documentId !== s.documentId) continue;
      const ws = words(a.name);
      // Plural-tolerant containment ("mccb" matches "mccbs").
      if (c.every((t) => ws.some((w) => w === t || w.startsWith(t) || t.startsWith(w)))) chosen.add(a.id);
    }
  }
  return [...chosen];
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
    select: { aiFileId: true, aiTextFileId: true, sections: { select: { aiFileId: true } } },
  });
  if (!doc) return;
  const cfg = await getEffectiveLlmConfig();
  if (cfg.anthropicApiKey) {
    const auth = { apiKey: cfg.anthropicApiKey, workspaceId: cfg.anthropicWorkspaceId || undefined };
    for (const id of new Set([doc.aiFileId, doc.aiTextFileId, ...doc.sections.map((s) => s.aiFileId)])) {
      if (id) await deleteKnowledgeFile(auth, id).catch(() => undefined);
    }
  }
  await prisma.knowledgeSection.deleteMany({ where: { documentId } });
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
      aiIndexedAt: null,
      aiSectionCount: null,
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
