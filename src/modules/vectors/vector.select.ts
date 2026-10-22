/**
 * Choosing the price-list pages a quote sends to Claude (instead of the whole
 * files). Two independent pickers, merged:
 *   1. PLAN — Claude reads the OUTLINE of the brand's price lists (sections
 *      built from the files themselves), the chosen rules and the BOQ, and names
 *      the sections the quote needs (prompt "quote.pages.select"). This catches
 *      what only the rules imply (accessories, alternatives, ordering tables).
 *   2. SEARCH — every BOQ line and rule line is searched in pgvector + BM25
 *      (vector.service); the best-voted sections fill the rest of the budget.
 * Works the same for every brand and every price-list layout: nothing here
 * knows a product — the outline, the queries and the pages all come from the
 * brand's files, the BOQ and the rules.
 */
import type { LlmProvider } from '../../lib/llm';
import { getPromptText } from '../prompts/prompt.service';
import {
  catalogueOutline,
  pagesWithCodes,
  queryLines,
  retrievePages,
  vectorsReadyFor,
  type RetrievedPage,
} from './vector.service';

/** Characters of page text sent with a quote (≈ 0.6 tokens per character). */
export const PAGE_BUDGET_CHARS = 110_000;
/** Sections Claude names are always sent, up to this cap. */
export const PLANNED_MAX_CHARS = 200_000;

export interface PageSelection {
  pages: RetrievedPage[];
  /** Sections and product phrases named by the plan (for the progress text). */
  plannedSections: number;
  plannedItems?: number;
  chars: number;
}

interface DocRef {
  id: number;
  aiFileId: string;
  brand: string | null;
  name: string | null;
  fileName: string;
}

function parseJson<T>(raw: string): T | null {
  try {
    const cleaned = raw.replace(/^```(?:json)?/i, '').replace(/```$/i, '').trim();
    const start = cleaned.search(/[[{]/);
    return JSON.parse(start > 0 ? cleaned.slice(start) : cleaned) as T;
  } catch {
    return null;
  }
}

/** Whether a quote for these files can use page search (all indexed from their current training). */
export async function pageSearchReady(docs: DocRef[]): Promise<boolean> {
  return vectorsReadyFor(docs);
}

/** The pages a new quote sends: planned sections first, then the search's best sections. */
export async function selectQuotePages(input: {
  provider: LlmProvider;
  docs: DocRef[];
  boqText: string;
  /** Full text of the chosen rules (trained or not). */
  rulesText: string;
  customerNotes: string;
}): Promise<PageSelection> {
  const documentIds = input.docs.map((d) => d.id);
  const outline = await catalogueOutline(documentIds);

  // 1. Plan: the outline is the stable part of the request (cached by the provider).
  const system = `${await getPromptText('quote.pages.select')}\n\nOUTLINE OF THE PRICE LISTS:\n${outline.text}`;
  const user =
    (input.rulesText.trim() ? `BRAND RULES:\n${input.rulesText.trim()}\n\n` : 'BRAND RULES: none selected.\n\n') +
    (input.customerNotes.trim() ? `CUSTOMER MESSAGE:\n${input.customerNotes.trim()}\n\n` : '') +
    `BOQ:\n${input.boqText.slice(0, 160_000)}`;
  const raw = await input.provider.complete([{ role: 'user', content: user }], {
    system,
    json: true,
    maxTokens: 8000,
    label: 'quote:pages-select',
  });
  const plan = parseJson<{ sections?: unknown; items?: unknown }>(raw) ?? {};
  const include = (Array.isArray(plan.sections) ? plan.sections : [])
    .map((id) => outline.byId.get(String(id).trim().toUpperCase()))
    .filter((s): s is NonNullable<typeof s> => Boolean(s));
  // The planned product phrases are the most precise queries: they lead the search
  // (each one's best sections get the first votes), then the BOQ's own lines.
  const items = (Array.isArray(plan.items) ? plan.items : []).map((t) => String(t).trim().slice(0, 300)).filter(Boolean);

  // 2. Search fills the rest of the budget.
  const { pages } = await retrievePages({
    documentIds,
    queries: [...items, ...queryLines([input.customerNotes, input.boqText].join('\n'))],
    ruleQueries: queryLines(input.rulesText),
    include,
    maxChars: PLANNED_MAX_CHARS,
    budgetChars: PAGE_BUDGET_CHARS,
  });
  return {
    pages,
    plannedSections: include.length,
    plannedItems: items.length,
    chars: pages.reduce((s, p) => s + p.content.length, 0),
  };
}

/**
 * The pages a chat turn sends: every page that prints a catalogue number of the
 * current BOM, plus the search's best sections for the user's message.
 */
export async function selectChatPages(input: { docs: DocRef[]; codes: string[]; message: string }): Promise<PageSelection> {
  const documentIds = input.docs.map((d) => d.id);
  const alreadyChosen = await pagesWithCodes(documentIds, input.codes);
  const { pages } = await retrievePages({
    documentIds,
    queries: queryLines(input.message),
    alreadyChosen,
    budgetChars: PAGE_BUDGET_CHARS,
  });
  return { pages, plannedSections: 0, chars: pages.reduce((s, p) => s + p.content.length, 0) };
}

/** Characters of NEW pages a fill-in request may add. */
export const FILL_BUDGET_CHARS = 60_000;

/**
 * Pages for lines Claude left without a product: each line's own words (which
 * usually name the product exactly) are searched; returns only pages that were
 * not sent yet.
 */
export async function pagesForLines(input: { docs: DocRef[]; have: RetrievedPage[]; lineTexts: string[] }): Promise<RetrievedPage[]> {
  if (!input.lineTexts.length) return [];
  const have = new Set(input.have.map((p) => `${p.documentId}:${p.pageNo}`));
  const { pages } = await retrievePages({
    documentIds: input.docs.map((d) => d.id),
    queries: input.lineTexts,
    alreadyChosen: input.have.map((p) => ({ documentId: p.documentId, pageNo: p.pageNo })),
    depth: 2,
    budgetChars: input.have.reduce((s, p) => s + p.content.length, 0) + FILL_BUDGET_CHARS,
  });
  return pages.filter((p) => !have.has(`${p.documentId}:${p.pageNo}`));
}

/** The pages as Claude reads them: grouped by file, each page marked. */
export async function pagesAsText(docs: DocRef[], pages: RetrievedPage[]): Promise<string> {
  const note = await getPromptText('quote.pages.note');
  const parts: string[] = [note];
  for (const d of docs) {
    const mine = pages.filter((p) => p.documentId === d.id).sort((a, b) => a.pageNo - b.pageNo);
    if (!mine.length) continue;
    parts.push(`\n===== BRAND ${d.brand ?? ''} — FILE "${d.name || d.fileName}" (${mine.length} page(s)) =====`);
    for (const p of mine) parts.push(`[page ${p.pageNo}]\n${p.content}`);
  }
  return parts.join('\n');
}
