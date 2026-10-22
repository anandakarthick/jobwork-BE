/**
 * Quote engine "claude" — knowledge in Claude.
 *
 * The brand's price lists live in Anthropic's Files API (trained from the Brands
 * page); nothing from them is parsed into our tables. A quote is ONE request:
 * the brand files (by id) + the chosen rules + the customer's message + the BOQ
 * text, answered with the complete feeder-grouped BOM. Our code then:
 *   1. verifies every catalogue number and price against the files' text
 *      (read transiently from the uploaded PDFs — never stored), voiding any
 *      the model invented;
 *   2. turns the BOM into the quote's bomJson (Excel) and flat lines.
 *
 * Chat follow-ups reuse the same files: a question is answered, a change comes
 * back as the complete updated BOM and is verified the same way.
 *
 * PAGE SEARCH (Settings → API Keys, needs the pgvector index): instead of the
 * whole price-list files, only the pages this BOQ needs are sent (see
 * vectors/vector.select.ts) — same prompts, same rules, same verification
 * against the complete files. Lines left without a product are searched by
 * their own words and priced in a small fill-in request (just those lines).
 * When any file is not indexed (or the search fails) the whole files are
 * attached exactly as before.
 */
import type { LlmMessage, LlmProvider } from '../../lib/llm';
import { HttpError } from '../../lib/http-error';
import { getPromptText } from '../prompts/prompt.service';
import { knowledgeFilesForBrands, selectKnowledgeFileIds, transientBrandText } from '../companies/knowledge.service';
import type { BomBoard } from './quote.bom';
import {
  pageSearchReady,
  pagesAsText,
  pagesForLines,
  selectChatPages,
  selectQuotePages,
  type PageSelection,
} from '../vectors/vector.select';
import type { RetrievedPage } from '../vectors/vector.service';

export interface KnowledgeItem {
  requirement: string;
  description: string;
  catalogNo: string | null;
  make: string;
  series: string | null;
  releaseModel: string | null;
  qty: number;
  listPrice: number | null;
  isAccessory: boolean;
  note: string;
}
export interface KnowledgeFeeder {
  name: string;
  feederRole: 'incoming' | 'outgoing' | null;
  feederQty: number;
  items: KnowledgeItem[];
}
export interface KnowledgeBoard {
  name: string;
  boardQty: number;
  feeders: KnowledgeFeeder[];
}

/** A flat quote line derived from the verified BOM (what quote_lines stores). */
export interface KnowledgeLine {
  lineNo: number;
  requirement: string;
  isAccessory: boolean;
  family: string | null;
  make: string | null;
  catalogNo: string | null;
  description: string | null;
  quantity: number;
  listPrice: number | null;
  discountPct: number;
  rate: number | null;
  amount: number | null;
  confidence: number;
  matchNote: string | null;
  priceListItemId: null;
}

export interface KnowledgeResult {
  boards: BomBoard[];
  lines: KnowledgeLine[];
  summary: string;
  matched: number;
  total: number;
  /** Items whose code/price could not be found in the files (voided). */
  voided: string[];
  /** Page search: what was sent instead of the whole files (null = whole files). */
  pagesSent?: { pages: number; totalPages: number; chars: number; plannedSections: number } | null;
}

const round2 = (n: number) => Math.round(n * 100) / 100;

/** Strip ``` fences and parse a JSON value the model returned. */
function parseJson<T>(raw: string): T {
  const cleaned = raw.replace(/^```(?:json)?/i, '').replace(/```$/i, '').trim();
  const start = cleaned.search(/[[{]/);
  return JSON.parse(start > 0 ? cleaned.slice(start) : cleaned) as T;
}

/** The brand files a quote attaches; a clear error when a brand isn't trained. */
export async function requireKnowledgeFiles(brands: string[]) {
  const files = await knowledgeFilesForBrands(brands);
  if (!files.length) {
    throw HttpError.badRequest(
      `No files are trained into Claude for ${brands.join(', ') || 'the selected brand'}. ` +
        'Open the brand, tick Train on its price lists and save (Settings → API Keys must be on the Claude engine).',
    );
  }
  return files;
}

/**
 * Verify the model's BOM against the files' text. A catalogue number must occur
 * verbatim in the text; its price must occur within the same neighbourhood.
 * Anything that fails is voided (code/price cleared, note says why) — the quote
 * never carries an invented code or price.
 */
export function verifyAgainstText(
  boards: KnowledgeBoard[],
  text: string,
): { boards: KnowledgeBoard[]; voided: string[]; voidedItems: KnowledgeItem[] } {
  const hay = text.replace(/\s+/g, ' ');
  const hayLower = hay.toLowerCase();
  const voided: string[] = [];
  const voidedItems: KnowledgeItem[] = [];
  const priceForms = (p: number) => {
    const n = Math.round(p);
    const forms = new Set<string>([String(n), n.toLocaleString('en-IN'), n.toLocaleString('en-US')]);
    if (!Number.isInteger(p)) forms.add(p.toFixed(2));
    return [...forms];
  };
  for (const b of boards) {
    for (const f of b.feeders ?? []) {
      for (const it of f.items ?? []) {
        if (!it.catalogNo) {
          it.listPrice = null;
          continue;
        }
        const code = it.catalogNo.trim();
        let idx = hayLower.indexOf(code.toLowerCase());
        if (idx < 0) {
          voided.push(`${code} (${it.description || it.requirement})`);
          voidedItems.push(it);
          it.note = `Not found in price list – manual verification required – "${code}" is not in the brand files. ${it.note ?? ''}`.trim();
          it.catalogNo = null;
          it.listPrice = null;
          continue;
        }
        if (it.listPrice != null) {
          // The price must sit near SOME occurrence of the code.
          let ok = false;
          const forms = priceForms(Number(it.listPrice));
          while (idx >= 0 && !ok) {
            const window = hay.slice(Math.max(0, idx - 400), idx + 400);
            ok = forms.some((p) => window.includes(p));
            idx = hayLower.indexOf(code.toLowerCase(), idx + 1);
          }
          if (!ok) {
            voided.push(`${code} price ${it.listPrice}`);
            voidedItems.push(it);
            it.note = `Price not confirmed in the price list – manual verification required. ${it.note ?? ''}`.trim();
            it.listPrice = null;
          }
        }
      }
    }
  }
  return { boards, voided, voidedItems };
}

/** Sanitise the model's JSON into typed boards (missing fields defaulted). */
function normaliseBoards(raw: unknown): KnowledgeBoard[] {
  const src = Array.isArray(raw) ? raw : [];
  const num = (v: unknown, d: number) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : d);
  return src
    .map((b) => {
      const board = (b ?? {}) as Partial<KnowledgeBoard>;
      const feeders = (Array.isArray(board.feeders) ? board.feeders : [])
        .map((f) => {
          const feeder = (f ?? {}) as Partial<KnowledgeFeeder>;
          const items = (Array.isArray(feeder.items) ? feeder.items : [])
            .map((i) => {
              // The model may echo the Excel/BOM field names (modelNo, catalogPrice,
              // reason) instead of ours — accept both so a chat change never loses codes.
              const it = (i ?? {}) as Partial<KnowledgeItem> & {
                modelNo?: unknown;
                catalogPrice?: unknown;
                price?: unknown;
                reason?: unknown;
                quantity?: unknown;
              };
              const requirement = String(it.requirement ?? it.description ?? '').trim().slice(0, 500);
              if (!requirement && !it.description) return null;
              const code = it.catalogNo ?? it.modelNo;
              const price = it.listPrice ?? it.catalogPrice ?? it.price;
              return {
                requirement: requirement || String(it.description ?? '').slice(0, 500),
                description: String(it.description ?? requirement).trim().slice(0, 500),
                catalogNo: code != null && String(code).trim() ? String(code).trim().slice(0, 120) : null,
                make: String(it.make ?? '').trim().slice(0, 80),
                series: it.series != null ? String(it.series).slice(0, 40) : null,
                releaseModel: it.releaseModel != null ? String(it.releaseModel).slice(0, 40) : null,
                qty: num(it.qty ?? it.quantity, 1),
                listPrice: price != null && price !== '' && Number.isFinite(Number(price)) ? Number(price) : null,
                isAccessory: Boolean(it.isAccessory),
                note: String(it.note ?? it.reason ?? '').trim().slice(0, 1000),
              } satisfies KnowledgeItem;
            })
            .filter((x): x is KnowledgeItem => x !== null);
          const role = String(feeder.feederRole ?? '').toLowerCase();
          return {
            name: String(feeder.name ?? 'Feeder').trim().slice(0, 120),
            feederRole: role.startsWith('in') ? 'incoming' : role.startsWith('out') ? 'outgoing' : null,
            feederQty: num(feeder.feederQty, 1),
            items,
          } satisfies KnowledgeFeeder;
        })
        .filter((f) => f.items.length > 0);
      return { name: String(board.name ?? 'Panel').trim().slice(0, 120), boardQty: num(board.boardQty, 1), feeders } satisfies KnowledgeBoard;
    })
    .filter((b) => b.feeders.length > 0);
}

/** The verified BOM as the Excel's board structure + flat quote lines. */
function toQuoteShape(boards: KnowledgeBoard[], defaultDiscountPct: number): { bom: BomBoard[]; lines: KnowledgeLine[] } {
  const bom: BomBoard[] = boards.map((b) => ({
    name: b.name,
    boardQty: b.boardQty,
    feeders: b.feeders.map((f) => ({
      name: f.name,
      feederQty: f.feederQty,
      items: f.items.map((it) => ({
        description: it.description || it.requirement,
        modelNo: it.catalogNo,
        make: it.make || null,
        qty: it.qty,
        catalogPrice: it.listPrice,
        discountPct: defaultDiscountPct,
      })),
    })),
  }));
  // Flat lines: identical (code + description) rows merge, quantities summed.
  const byKey = new Map<string, KnowledgeLine>();
  for (const b of boards) {
    for (const f of b.feeders) {
      for (const it of f.items) {
        const quantity = it.qty * f.feederQty * b.boardQty;
        const key = it.catalogNo ? `cat:${it.catalogNo}:${it.description}` : `req:${it.requirement.toLowerCase()}`;
        const existing = byKey.get(key);
        if (existing) {
          existing.quantity += quantity;
          existing.amount = existing.rate != null ? round2(existing.rate * existing.quantity) : null;
          continue;
        }
        const rate = it.listPrice != null ? round2(it.listPrice * (1 - defaultDiscountPct / 100)) : null;
        byKey.set(key, {
          lineNo: byKey.size + 1,
          requirement: it.requirement,
          isAccessory: it.isAccessory,
          family: it.series ? `${it.series}${it.releaseModel ? ` ${it.releaseModel}` : ''}` : null,
          make: it.make || null,
          catalogNo: it.catalogNo,
          description: it.description || null,
          quantity,
          listPrice: it.listPrice,
          discountPct: defaultDiscountPct,
          rate,
          amount: rate != null ? round2(rate * quantity) : null,
          confidence: it.catalogNo ? (it.listPrice != null ? 0.9 : 0.5) : 0,
          matchNote: it.note || null,
          priceListItemId: null,
        });
      }
    }
  }
  return { bom, lines: [...byKey.values()] };
}

/** Verify + shape a BOM the model returned (generation or chat change). */
async function finishBoards(
  rawBoards: unknown,
  files: Awaited<ReturnType<typeof knowledgeFilesForBrands>>,
  defaultDiscountPct: number,
  summary: string,
  /** Page search: price the lines still open from more pages (mutates the boards). */
  fill?: (boards: KnowledgeBoard[]) => Promise<void>,
): Promise<KnowledgeResult> {
  const boards = normaliseBoards(rawBoards);
  if (!boards.length) throw HttpError.badRequest('Claude returned no bill of materials for this BOQ.');
  const text = await transientBrandText(files);
  const first = verifyAgainstText(boards, text);
  let voided = first.voided;
  if (fill) {
    await fill(boards).catch((err) => console.warn('[page search] fill-in failed:', (err as Error).message));
    // Re-verify (the filled codes too); a first-pass notice stays only while its line is still open.
    const second = verifyAgainstText(boards, text);
    voided = [
      ...first.voided.filter((_, i) => !first.voidedItems[i]!.catalogNo || first.voidedItems[i]!.listPrice == null),
      ...second.voided,
    ];
  }
  const { bom, lines } = toQuoteShape(boards, defaultDiscountPct);
  const total = lines.length;
  const matched = lines.filter((l) => l.catalogNo).length;
  return { boards: bom, lines, summary, matched, total, voided };
}

/**
 * Page search fill-in: the lines left without a product are searched by their
 * own words; the pages found that were not sent yet go to Claude with the rules
 * and just those lines, and the codes it returns are written into the BOM. Only
 * the open lines are answered, so this costs a fraction of asking again.
 */
async function fillOpenLines(opts: {
  provider: LlmProvider;
  files: KnowledgeFiles;
  boards: KnowledgeBoard[];
  have: RetrievedPage[];
  ruleFileIds: string[];
  rulesText: string;
  brands: string[];
  /** Lines to leave alone (chat: lines that were already open before the change). */
  skip?: (it: KnowledgeItem) => boolean;
  onProgress?: GenerateInput['onProgress'];
}): Promise<void> {
  const open: { ref: string; it: KnowledgeItem; board: string; feeder: string }[] = [];
  for (const b of opts.boards)
    for (const f of b.feeders)
      for (const it of f.items)
        if (!it.catalogNo && !opts.skip?.(it)) open.push({ ref: `L${open.length + 1}`, it, board: b.name, feeder: f.name });
  if (!open.length) return;
  const texts = [...new Set(open.map((o) => [o.it.description, o.it.requirement].filter(Boolean).join(' — ')))];
  const more = await pagesForLines({ docs: opts.files, have: opts.have, lineTexts: texts });
  if (!more.length) return;
  opts.onProgress?.('extract', `Claude is pricing ${open.length} open line(s) from ${more.length} more price-list page(s)`);
  const system = await getPromptText('quote.pages.fill');
  const user =
    `BRANDS: ${opts.brands.join(', ')}\n` +
    (opts.ruleFileIds.length ? `BRAND RULES: ${opts.ruleFileIds.length} rule file(s) are attached.\n` : '') +
    (opts.rulesText.trim() ? `BRAND RULES (text):\n${opts.rulesText.trim()}\n` : '') +
    `\nLINES:\n${JSON.stringify(
      open.map((o) => ({ ref: o.ref, panel: o.board, feeder: o.feeder, requirement: o.it.requirement, description: o.it.description, qty: o.it.qty })),
    )}`;
  const raw = await opts.provider.completeWithKnowledge!(
    { fileIds: opts.ruleFileIds, contextText: await pagesAsText(opts.files, more), messages: [{ role: 'user', content: user }] },
    { system, json: true, maxTokens: 16000, label: 'quote:pages-fill' },
  );
  const answer = parseJson<{ items?: unknown }>(raw);
  const byRef = new Map(open.map((o) => [o.ref, o.it]));
  for (const a of (Array.isArray(answer.items) ? answer.items : []) as Record<string, unknown>[]) {
    const it = byRef.get(String(a.ref ?? ''));
    const code = a.catalogNo != null ? String(a.catalogNo).trim() : '';
    if (!it || !code) continue;
    it.catalogNo = code.slice(0, 120);
    const price = Number(a.listPrice);
    it.listPrice = a.listPrice != null && a.listPrice !== '' && Number.isFinite(price) ? price : null;
    if (a.description) it.description = String(a.description).trim().slice(0, 500);
    it.note = String(a.note ?? '').trim().slice(0, 1000);
  }
}

export interface GenerateInput {
  provider: LlmProvider;
  brands: string[];
  /** File ids of the rules trained into Claude (attached after the price lists). */
  ruleFileIds: string[];
  /** Text of selected rules that are not trained (yet) — sent inline. */
  rulesText: string;
  customerNotes: string;
  boqText: string;
  customerName: string;
  defaultDiscountPct: number;
  /** Send only the matching price-list pages (Settings → API Keys) when the index is ready. */
  pageSearch?: boolean;
  /** Every chosen rule's text — the page search reads it (trained rules still go by file id). */
  rulesAllText?: string;
  onProgress?: (stage: 'collect' | 'extract' | 'assemble', detail: string) => void;
}

type KnowledgeFiles = Awaited<ReturnType<typeof knowledgeFilesForBrands>>;

/** Pages in the brand files (for "sent 44 of 204 pages"). */
function totalPagesOf(files: KnowledgeFiles): number {
  return files.reduce((s, f) => s + (f.aiPages ?? 0), 0);
}

/** The page search's choice for a quote, or null → attach the whole files. */
async function quotePages(input: GenerateInput, files: KnowledgeFiles): Promise<PageSelection | null> {
  if (!input.pageSearch || !(await pageSearchReady(files))) return null;
  input.onProgress?.('collect', 'Finding the price-list pages this BOQ and the rules need');
  try {
    const sel = await selectQuotePages({
      provider: input.provider,
      docs: files,
      boqText: input.boqText,
      rulesText: input.rulesAllText ?? input.rulesText,
      customerNotes: input.customerNotes,
    });
    return sel.pages.length ? sel : null;
  } catch (err) {
    console.warn('[page search] falling back to the whole files:', (err as Error).message);
    return null;
  }
}

/** One request → the complete, verified BOM. */
export async function generateWithKnowledge(input: GenerateInput): Promise<KnowledgeResult> {
  if (!input.provider.completeWithKnowledge) {
    throw HttpError.badRequest('The Claude knowledge engine needs the Claude provider (Settings → API Keys).');
  }
  input.onProgress?.('collect', 'Attaching the brand files trained into Claude');
  const files = await requireKnowledgeFiles(input.brands);
  const system = await getPromptText('quote.knowledge.system');
  const ruleNote =
    input.ruleFileIds.length || input.rulesText.trim()
      ? `BRAND RULES (chosen for this quote): ${input.ruleFileIds.length ? `${input.ruleFileIds.length} rule file(s) are attached after the price lists.` : ''}` +
        (input.rulesText.trim() ? `\n${input.rulesText.trim()}` : '') +
        '\n\n'
      : 'BRAND RULES: none selected.\n\n';
  const user =
    `CUSTOMER: ${input.customerName}\nBRANDS: ${input.brands.join(', ')}\n\n` +
    ruleNote +
    (input.customerNotes.trim() ? `CUSTOMER MESSAGE:\n${input.customerNotes.trim()}\n\n` : '') +
    `BOQ (bill of quantities):\n${input.boqText.slice(0, 160_000)}\n\n` +
    'Produce the complete JSON described in your instructions.';
  const selection = await quotePages(input, files);
  const ask = async (pages: RetrievedPage[] | null) => {
    const raw = await input.provider.completeWithKnowledge!(
      pages
        ? { fileIds: input.ruleFileIds, contextText: await pagesAsText(files, pages), messages: [{ role: 'user', content: user }] }
        : { fileIds: [...selectKnowledgeFileIds(files).fileIds, ...input.ruleFileIds], messages: [{ role: 'user', content: user }] },
      { system, json: true, maxTokens: 24000, label: pages ? 'quote:knowledge-pages' : 'quote:knowledge' },
    );
    const parsed = parseJson<{ summary?: string; boards?: unknown }>(raw);
    input.onProgress?.('assemble', 'Verifying every code and price against the brand files');
    const fill = pages
      ? (boards: KnowledgeBoard[]) =>
          fillOpenLines({
            provider: input.provider,
            files,
            boards,
            have: pages,
            ruleFileIds: input.ruleFileIds,
            rulesText: input.rulesText,
            brands: input.brands,
            onProgress: input.onProgress,
          })
      : undefined;
    return finishBoards(parsed.boards, files, input.defaultDiscountPct, String(parsed.summary ?? '').slice(0, 2000), fill);
  };

  if (!selection) {
    input.onProgress?.('extract', `Claude is reading ${files.length} price-list file(s), ${input.ruleFileIds.length} rule file(s) and the BOQ`);
    return { ...(await ask(null)), pagesSent: null };
  }
  const totalPages = totalPagesOf(files);
  input.onProgress?.(
    'extract',
    `Claude is reading ${selection.pages.length} of ${totalPages} price-list pages, ${input.ruleFileIds.length} rule file(s) and the BOQ`,
  );
  // One full request, then a small fill-in for any line left open. (Asking for the
  // whole BOM a second time was tried and dropped: the answer is the costly part.)
  const result = await ask(selection.pages);
  return {
    ...result,
    pagesSent: {
      pages: selection.pages.length,
      totalPages,
      chars: selection.chars,
      plannedSections: selection.plannedSections,
    },
  };
}

export interface ChatInput {
  provider: LlmProvider;
  brands: string[];
  ruleFileIds: string[];
  rulesText: string;
  customerName: string;
  currentBoards: BomBoard[] | null;
  history: LlmMessage[];
  message: string;
  defaultDiscountPct: number;
  /** Send only the matching price-list pages (Settings → API Keys) when the index is ready. */
  pageSearch?: boolean;
}

export interface ChatResult {
  reply: string;
  fileName: string | null;
  /** Present when the model changed the BOM (already verified). */
  result: KnowledgeResult | null;
}

/** A follow-up message: answer, or the complete updated (verified) BOM. */
export async function chatWithKnowledge(input: ChatInput): Promise<ChatResult> {
  if (!input.provider.completeWithKnowledge) {
    throw HttpError.badRequest('The Claude knowledge engine needs the Claude provider (Settings → API Keys).');
  }
  const files = await requireKnowledgeFiles(input.brands);
  const system = await getPromptText('quote.knowledge.chat');
  // Hand the current BOM over in the SAME field names the answer must use
  // (catalogNo / listPrice / qty / note), so an updated BOM comes back in the
  // shape the code reads — the Excel's modelNo / catalogPrice names stay internal.
  const current = (input.currentBoards ?? []).map((b) => ({
    name: b.name,
    boardQty: b.boardQty,
    feeders: b.feeders.map((f) => ({
      name: f.name,
      feederQty: f.feederQty,
      items: f.items.map((it) => ({
        requirement: it.description,
        description: it.description,
        catalogNo: it.modelNo,
        make: it.make ?? '',
        qty: it.qty,
        listPrice: it.catalogPrice,
        note: '',
      })),
    })),
  }));
  const context =
    `CUSTOMER: ${input.customerName}\nBRANDS: ${input.brands.join(', ')}\n\n` +
    (input.ruleFileIds.length ? `BRAND RULES: ${input.ruleFileIds.length} rule file(s) are attached after the price lists.\n` : '') +
    (input.rulesText.trim() ? `BRAND RULES (text):\n${input.rulesText.trim()}\n\n` : '\n') +
    `CURRENT BOM (items carry: requirement, description, catalogNo, make, qty, listPrice, note):\n${JSON.stringify(current)}`;
  // The files + context open the conversation; the stored chat follows; the new
  // message closes it.
  const messages: LlmMessage[] = [
    { role: 'user', content: `${context}\n\n(Conversation follows.)` },
    { role: 'assistant', content: 'Understood — I have the brand files, the rules and the current BOM.' },
    ...input.history.filter((m) => m.role !== 'system' && m.content.trim()),
    { role: 'user', content: input.message },
  ];
  // Page search: the pages of the current BOM's products + the best pages for the message.
  let pages: RetrievedPage[] | null = null;
  if (input.pageSearch && (await pageSearchReady(files))) {
    const codes = (input.currentBoards ?? [])
      .flatMap((b) => b.feeders.flatMap((f) => f.items.map((it) => it.modelNo ?? '')))
      .filter(Boolean);
    pages = await selectChatPages({ docs: files, codes, message: input.message })
      .then((sel) => (sel.pages.length ? sel.pages : null))
      .catch((err) => {
        console.warn('[page search] chat falls back to the whole files:', (err as Error).message);
        return null;
      });
  }
  const ask = async (pg: RetrievedPage[] | null): Promise<ChatResult> => {
    const raw = await input.provider.completeWithKnowledge!(
      pg
        ? { fileIds: input.ruleFileIds, contextText: await pagesAsText(files, pg), messages }
        : { fileIds: [...selectKnowledgeFileIds(files).fileIds, ...input.ruleFileIds], messages },
      { system, json: true, maxTokens: 24000, label: pg ? 'quote:knowledge-chat-pages' : 'quote:knowledge-chat' },
    );
    const parsed = parseJson<{ reply?: string; bom?: unknown; fileName?: string | null }>(raw);
    const reply = String(parsed.reply ?? '').trim().slice(0, 2000);
    const openBefore = new Set(
      (input.currentBoards ?? []).flatMap((b) =>
        b.feeders.flatMap((f) => f.items.filter((it) => !it.modelNo).map((it) => it.description.trim().toLowerCase())),
      ),
    );
    const fill = pg
      ? (boards: KnowledgeBoard[]) =>
          fillOpenLines({
            provider: input.provider,
            files,
            boards,
            have: pg,
            ruleFileIds: input.ruleFileIds,
            rulesText: input.rulesText,
            brands: input.brands,
            skip: (it) => openBefore.has(it.description.trim().toLowerCase()),
          })
      : undefined;
    const result =
      Array.isArray(parsed.bom) && parsed.bom.length
        ? await finishBoards(parsed.bom, files, input.defaultDiscountPct, reply, fill)
        : null;
    return { reply, fileName: parsed.fileName ? String(parsed.fileName) : null, result };
  };
  return ask(pages);
}
