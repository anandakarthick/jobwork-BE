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
 */
import type { LlmMessage, LlmProvider } from '../../lib/llm';
import { HttpError } from '../../lib/http-error';
import { getPromptText } from '../prompts/prompt.service';
import {
  knowledgeFilesForBrands,
  knowledgeSectionsForBrands,
  selectKnowledgeFileIds,
  selectSectionsForBoq,
  transientBrandText,
} from '../companies/knowledge.service';
import type { BomBoard } from './quote.bom';

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
  /** Catalogue sections attached for this run (null = full files / all sections). */
  sectionIds: number[] | null;
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
export function verifyAgainstText(boards: KnowledgeBoard[], text: string): { boards: KnowledgeBoard[]; voided: string[] } {
  const hay = text.replace(/\s+/g, ' ');
  const hayLower = hay.toLowerCase();
  const voided: string[] = [];
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
            it.note = `Price not confirmed in the price list – manual verification required. ${it.note ?? ''}`.trim();
            it.listPrice = null;
          }
        }
      }
    }
  }
  return { boards, voided };
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
              const it = (i ?? {}) as Partial<KnowledgeItem>;
              const requirement = String(it.requirement ?? it.description ?? '').trim().slice(0, 500);
              if (!requirement && !it.description) return null;
              return {
                requirement: requirement || String(it.description ?? '').slice(0, 500),
                description: String(it.description ?? requirement).trim().slice(0, 500),
                catalogNo: it.catalogNo != null && String(it.catalogNo).trim() ? String(it.catalogNo).trim().slice(0, 120) : null,
                make: String(it.make ?? '').trim().slice(0, 80),
                series: it.series != null ? String(it.series).slice(0, 40) : null,
                releaseModel: it.releaseModel != null ? String(it.releaseModel).slice(0, 40) : null,
                qty: num(it.qty, 1),
                listPrice: it.listPrice != null && Number.isFinite(Number(it.listPrice)) ? Number(it.listPrice) : null,
                isAccessory: Boolean(it.isAccessory),
                note: String(it.note ?? '').trim().slice(0, 1000),
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
): Promise<KnowledgeResult> {
  const boards = normaliseBoards(rawBoards);
  if (!boards.length) throw HttpError.badRequest('Claude returned no bill of materials for this BOQ.');
  const text = await transientBrandText(files);
  const { voided } = verifyAgainstText(boards, text);
  const { bom, lines } = toQuoteShape(boards, defaultDiscountPct);
  const total = lines.length;
  const matched = lines.filter((l) => l.catalogNo).length;
  return { boards: bom, lines, summary, matched, total, voided, sectionIds: null };
}

/**
 * What to attach for the brands: the catalogue-index sections a BOQ needs (picked
 * by the fast model, or the given ids), falling back to the full text files when
 * a file has no index yet. `partial` = fewer than all sections were attached.
 */
async function attachmentsFor(
  provider: LlmProvider,
  brands: string[],
  files: Awaited<ReturnType<typeof knowledgeFilesForBrands>>,
  boqText: string,
  sectionIds: number[] | null | undefined,
): Promise<{ fileIds: string[]; sectionIds: number[] | null; partial: boolean; detail: string }> {
  const sections = await knowledgeSectionsForBrands(brands);
  const indexedDocs = new Set(sections.map((s) => s.documentId));
  // Files without an index are attached whole.
  const whole = selectKnowledgeFileIds(files.filter((f) => !indexedDocs.has(f.id))).fileIds;
  if (!sections.length) return { fileIds: whole, sectionIds: null, partial: false, detail: `${whole.length} price-list file(s)` };

  let ids: number[];
  let partial: boolean;
  if (sectionIds && sectionIds.length) {
    ids = sectionIds.filter((id) => sections.some((s) => s.id === id));
    partial = ids.length < sections.length;
    if (!ids.length) {
      ids = sections.map((s) => s.id);
      partial = false;
    }
  } else {
    ({ ids, partial } = await selectSectionsForBoq(provider, boqText, sections));
  }
  const chosen = sections.filter((s) => ids.includes(s.id));
  return {
    fileIds: [...chosen.map((s) => s.aiFileId), ...whole],
    sectionIds: partial ? ids : null,
    partial,
    detail: `${chosen.length} of ${sections.length} catalogue section(s)${whole.length ? ` + ${whole.length} full file(s)` : ''}`,
  };
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
  /** Reuse a previous run's section pick (chat regeneration); omit to pick afresh. */
  sectionIds?: number[] | null;
  onProgress?: (stage: 'collect' | 'extract' | 'assemble', detail: string) => void;
}

/** One request → the complete, verified BOM. */
export async function generateWithKnowledge(input: GenerateInput): Promise<KnowledgeResult> {
  if (!input.provider.completeWithKnowledge) {
    throw HttpError.badRequest('The Claude knowledge engine needs the Claude provider (Settings → API Keys).');
  }
  input.onProgress?.('collect', 'Choosing the catalogue sections this BOQ needs');
  const files = await requireKnowledgeFiles(input.brands);
  const attach = await attachmentsFor(input.provider, input.brands, files, input.boqText, input.sectionIds);
  const result = await generateOnce(input, files, attach.fileIds, attach.detail);
  result.sectionIds = attach.sectionIds;
  // Safety net: if only some sections were attached and a noticeable share of
  // lines came back unpriced, the pick probably missed a section — run once more
  // with everything and keep the better result.
  const unpriced = result.total - result.matched;
  if (attach.partial && result.total > 0 && unpriced / result.total > 0.15) {
    const all = await attachmentsFor(input.provider, input.brands, files, input.boqText, null);
    const allIds = (await knowledgeSectionsForBrands(input.brands)).map((s) => s.id);
    const full = await attachmentsFor(input.provider, input.brands, files, input.boqText, allIds);
    const retry = await generateOnce(input, files, (full.fileIds.length ? full : all).fileIds, 'all catalogue sections (retry)');
    if (retry.matched > result.matched) {
      retry.sectionIds = null;
      return retry;
    }
  }
  return result;
}

async function generateOnce(
  input: GenerateInput,
  files: Awaited<ReturnType<typeof knowledgeFilesForBrands>>,
  fileIds: string[],
  attachDetail: string,
): Promise<KnowledgeResult> {
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
  input.onProgress?.('extract', `Claude is reading ${attachDetail}, ${input.ruleFileIds.length} rule file(s) and the BOQ`);
  const raw = await input.provider.completeWithKnowledge!(
    { fileIds: [...fileIds, ...input.ruleFileIds], messages: [{ role: 'user', content: user }] },
    { system, json: true, label: 'quote:knowledge' },
  );
  const parsed = parseJson<{ summary?: string; boards?: unknown }>(raw);
  input.onProgress?.('assemble', 'Verifying every code and price against the brand files');
  return finishBoards(parsed.boards, files, input.defaultDiscountPct, String(parsed.summary ?? '').slice(0, 2000));
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
  /** The sections the quote was generated with (reused for the chat). */
  sectionIds?: number[] | null;
}

export interface ChatResult {
  reply: string;
  fileName: string | null;
  /** Present when the model changed the BOM (already verified). */
  result: KnowledgeResult | null;
  /** "question" was answered by the fast model; "change" by the main model. */
  kind: 'question' | 'change';
}

/** Fast-model triage: does the message ask for information or for a change? */
async function classifyMessage(provider: LlmProvider, message: string, history: LlmMessage[]): Promise<'question' | 'change'> {
  if (!provider.completeWithKnowledge) return 'change';
  // Obvious change words skip the call.
  if (/\b(change|replace|swap|switch|remove|delete|add|increase|decrease|set|make|update|rename|regenerate|discount|qty|quantity|instead)\b/i.test(message)) {
    return 'change';
  }
  try {
    const system = await getPromptText('knowledge.classify.system');
    const recent = history.slice(-4).map((m) => `${m.role}: ${m.content.slice(0, 300)}`).join('\n');
    const raw = await provider.completeWithKnowledge(
      { fileIds: [], messages: [{ role: 'user', content: `RECENT CHAT:\n${recent}\n\nLATEST MESSAGE:\n${message}` }] },
      { system, json: true, maxTokens: 200, label: 'knowledge:classify', tier: 'fast' },
    );
    const parsed = parseJson<{ kind?: string }>(raw);
    return parsed.kind === 'question' ? 'question' : 'change';
  } catch {
    return 'change';
  }
}

/** A follow-up message: answer, or the complete updated (verified) BOM. */
export async function chatWithKnowledge(input: ChatInput): Promise<ChatResult> {
  if (!input.provider.completeWithKnowledge) {
    throw HttpError.badRequest('The Claude knowledge engine needs the Claude provider (Settings → API Keys).');
  }
  const files = await requireKnowledgeFiles(input.brands);
  // Questions go to the fast model (cheap); changes need the main model.
  const kind = await classifyMessage(input.provider, input.message, input.history);
  const attach = await attachmentsFor(input.provider, input.brands, files, input.message, input.sectionIds);
  const system = await getPromptText('quote.knowledge.chat');
  const context =
    `CUSTOMER: ${input.customerName}\nBRANDS: ${input.brands.join(', ')}\n\n` +
    (input.ruleFileIds.length ? `BRAND RULES: ${input.ruleFileIds.length} rule file(s) are attached after the price lists.\n` : '') +
    (input.rulesText.trim() ? `BRAND RULES (text):\n${input.rulesText.trim()}\n\n` : '\n') +
    `CURRENT BOM:\n${JSON.stringify(input.currentBoards ?? [])}`;
  // The files + context open the conversation; the stored chat follows; the new
  // message closes it.
  const messages: LlmMessage[] = [
    { role: 'user', content: `${context}\n\n(Conversation follows.)` },
    { role: 'assistant', content: 'Understood — I have the brand files, the rules and the current BOM.' },
    ...input.history.filter((m) => m.role !== 'system' && m.content.trim()),
    { role: 'user', content: input.message },
  ];
  const raw = await input.provider.completeWithKnowledge(
    { fileIds: [...attach.fileIds, ...input.ruleFileIds], messages },
    {
      system,
      json: true,
      label: kind === 'question' ? 'quote:knowledge-question' : 'quote:knowledge-chat',
      tier: kind === 'question' ? 'fast' : 'main',
      ...(kind === 'question' ? { maxTokens: 3000 } : {}),
    },
  );
  const parsed = parseJson<{ reply?: string; bom?: unknown; fileName?: string | null }>(raw);
  const reply = String(parsed.reply ?? '').trim().slice(0, 2000);
  // A question never changes the quote, whatever the model returned.
  const result =
    kind === 'change' && Array.isArray(parsed.bom) && parsed.bom.length
      ? await finishBoards(parsed.bom, files, input.defaultDiscountPct, reply)
      : null;
  if (result) result.sectionIds = attach.sectionIds;
  return { reply, fileName: parsed.fileName ? String(parsed.fileName) : null, result, kind };
}
