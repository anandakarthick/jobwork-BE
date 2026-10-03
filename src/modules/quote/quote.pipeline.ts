/**
 * Quote generation pipeline.
 *
 *   1. extractRequirements  (LLM)   — messy BOQ text → structured line items
 *   2. retrieve candidates  (code)  — small candidate set per line from the DB
 *   3. matchRequirements    (LLM)   — pick the catalog no. per line from candidates
 *   4. priceLines           (code)  — list price × discount → rate, amount
 *
 * Only steps 1 and 3 call the model, and they only ever see a small, focused
 * payload (the requirement + a handful of candidates). Prices are always
 * pulled from the DB and computed in code — the model never does arithmetic.
 */
import type { PriceListItem } from '@prisma/client';
import type { LlmProvider } from '../../lib/llm';
import { loadPool, rankCandidates, type RequirementQuery } from '../price-list/price-list.retrieval';
import { cleanFamily } from '../price-list/price-list.parser';
import { getPromptText } from '../prompts/prompt.service';

export interface Requirement {
  lineNo: number;
  /** Verbatim requirement text from the input. */
  requirement: string;
  quantity: number;
  isAccessory: boolean;
  /** Number of identical panels/assemblies this line belongs to (multiplier). */
  panelQty: number;
  /** For accessories: the lineNo of the breaker they belong to (drives qty). */
  parentLineNo: number | null;
  /** The board / panel this line belongs to (e.g. "MV PANEL"), for the feeder-
   *  grouped BOM export. Null when the BOQ has no distinct panels. */
  board: string | null;
  ratingAmp: number | null;
  poles: number | null;
  breakingKa: number | null;
  /** Release type the spec calls for: "thermal-magnetic" | "microprocessor" | null. */
  releaseType: string | null;
  /**
   * Breaker construction the BOQ states for this line — "single-break",
   * "double-break", or any other construction word it uses, verbatim; null when
   * the BOQ says nothing. BOQs usually state it ONCE in a note ("the incoming MCCB
   * shall be double-break, all outgoing MCCBs single-break") that applies to
   * every breaker below, so it is carried onto each line. The brand rules decide
   * which product series a construction maps to.
   */
  construction: string | null;
  /**
   * Protection functions the BOQ asks of the release, as the BOQ writes them
   * ("LSI", "LSIG", "LSING", "LS", …); null when not stated. Also usually a global
   * note ("250A and above shall be microprocessor based with LSIG release").
   */
  protection: string | null;
  /**
   * Operating / coil voltage the line is specified at, verbatim (e.g. "240VAC",
   * "415VAC", "230V", "24VDC"). Selects a voltage-specific price-list variant when
   * the catalog offers several, keeps lines that differ only by voltage separate,
   * and is shown in the quote. Null when the line states no voltage.
   */
  voltage: string | null;
  /**
   * A short customer-specified attribute that distinguishes this line from an
   * otherwise identical one but that the price list may NOT encode as a separate
   * catalog number — most commonly an indicator-lamp / push-button COLOUR (e.g.
   * "Red", "Yellow", "Blue", "Green", "Amber"). Kept so different variants stay
   * separate lines and the colour shows in the quote, instead of collapsing into
   * one line under a shared catalog number.
   */
  variant: string | null;
  /**
   * Whether the BOQ lists this item under an INCOMING (incomer, I/C) or OUTGOING
   * (O/G) feeder heading; accessories inherit their breaker's role. Shown on
   * every output line so the quote says which is which.
   */
  feederRole: 'incoming' | 'outgoing' | null;
  keywords: string[];
}

export interface MatchDecision {
  lineNo: number;
  catalogNo: string | null;
  confidence: number;
  reason: string;
}

export interface PricedLine {
  lineNo: number;
  requirement: string;
  isAccessory: boolean;
  quantity: number;
  family: string | null;
  make: string;
  /** Product type/series designation (e.g. DN3-630N), from the price-list item. */
  type: string | null;
  catalogNo: string | null;
  description: string | null;
  listPrice: number | null;
  discountPct: number;
  rate: number | null;
  amount: number | null;
  confidence: number;
  matchNote: string;
  priceListItemId: number | null;
  /** Board/panel this line belongs to, and the parent breaker's lineNo — carried
   *  for the feeder-grouped BOM export. Optional (only the live pipeline sets them). */
  board?: string | null;
  parentLineNo?: number | null;
  lineRef?: number;
  /** Variant attribute (e.g. lamp colour) carried from the requirement — keeps
   *  distinct variants from consolidating and is shown in the description.
   *  Optional: only the live pricing pipeline sets it; the description already
   *  carries the colour, so downstream consumers (xlsx from stored lines) omit it. */
  variant?: string | null;
  /** Operating/coil voltage carried from the requirement — same role as variant
   *  (keeps voltage-distinct lines apart, shown in the description). Optional. */
  voltage?: string | null;
  /** Incoming / outgoing feeder role from the BOQ (see Requirement.feederRole). */
  feederRole?: 'incoming' | 'outgoing' | null;
}

// The extraction / accessory / matching instruction texts live in the system_prompts
// table (Settings → AI prompts), seeded from ../prompts/prompt.defaults.ts.

/** "Incomer", "I/C", "incoming" → incoming; "O/G", "outgoing" → outgoing; else null. */
function normaliseRole(raw: unknown): 'incoming' | 'outgoing' | null {
  const s = String(raw ?? '').toLowerCase();
  if (/incom|i\/c/.test(s)) return 'incoming';
  if (/outgo|o\/g/.test(s)) return 'outgoing';
  return null;
}

/** "Incoming" / "Outgoing" for display, or null. */
export const roleLabel = (role: 'incoming' | 'outgoing' | null | undefined): string | null =>
  role === 'incoming' ? 'Incoming' : role === 'outgoing' ? 'Outgoing' : null;

/** Strip ``` fences and parse a JSON value the model returned. */
function parseJson<T>(raw: string): T {
  const cleaned = raw.replace(/^```(?:json)?/i, '').replace(/```$/i, '').trim();
  const start = cleaned.search(/[[{]/);
  return JSON.parse(start > 0 ? cleaned.slice(start) : cleaned) as T;
}

/** Step 1 — extract structured requirement lines from the merged input text.
 *  `extraInstructions` is user-authored guidance from Settings → Configure Prompt,
 *  appended to the built-in system prompt so users can steer extraction. */
export async function extractRequirements(
  provider: LlmProvider,
  inputText: string,
  ctx: { brand: string; category: string },
  extraInstructions = '',
): Promise<Requirement[]> {
  const base = await getPromptText('quote.extract.system');
  const system = extraInstructions.trim()
    ? `${base}\n\nADDITIONAL INSTRUCTIONS (the customer's message and the brand rules chosen for this quote — follow these too, let them override the defaults above where they conflict, and treat any accessory they make mandatory or conditional as required per accessory rule 5):\n${extraInstructions.trim()}`
    : base;
  const user =
    `Preferred brand: ${ctx.brand}${ctx.category ? ` (primary product: ${ctx.category})` : ''}. ` +
    'Extract EVERY line item from the documents below — all product types, not just ' +
    'the primary product.\n\n' +
    // The reader already shares INPUT_BUDGET_CHARS across all attached files; this
    // is only a last-resort guard so one call can never exceed the context window.
    `Input documents:\n${inputText.slice(0, 160_000)}\n\n` +
    (await getPromptText('quote.extract.fields'));
  const raw = await provider.complete([{ role: 'user', content: user }], {
    system,
    json: true,
    maxTokens: 8000,
    label: 'quote:extract',
  });
  const parsed = parseJson<{ lines?: Requirement[] }>(raw);
  const lines = parsed.lines ?? [];
  const extracted = lines.map((l, i) => {
    // Deterministic multiply: per-panel count × number of identical panels.
    const perPanel = Number(l.quantity) > 0 ? Math.round(Number(l.quantity)) : 1;
    const panelQty = Number(l.panelQty) > 0 ? Math.round(Number(l.panelQty)) : 1;
    return {
    lineNo: l.lineNo ?? i + 1,
    requirement: String(l.requirement ?? '').slice(0, 500),
    quantity: perPanel * panelQty,
    panelQty,
    isAccessory: Boolean(l.isAccessory),
    parentLineNo: l.parentLineNo != null ? Number(l.parentLineNo) : null,
    board: l.board != null && String(l.board).trim() ? String(l.board).trim().slice(0, 80) : null,
    ratingAmp: l.ratingAmp != null ? Number(l.ratingAmp) : null,
    poles: l.poles != null ? Number(l.poles) : null,
    breakingKa: l.breakingKa != null ? Number(l.breakingKa) : null,
    releaseType: l.releaseType != null ? String(l.releaseType).toLowerCase().slice(0, 40) : null,
    construction:
      l.construction != null && String(l.construction).trim()
        ? String(l.construction).trim().toLowerCase().slice(0, 40)
        : null,
    protection:
      l.protection != null && String(l.protection).trim()
        ? String(l.protection).trim().toUpperCase().slice(0, 20)
        : null,
    voltage: l.voltage != null && String(l.voltage).trim() ? String(l.voltage).trim().slice(0, 40) : null,
    variant: l.variant != null && String(l.variant).trim() ? String(l.variant).trim().slice(0, 40) : null,
    feederRole: normaliseRole(l.feederRole),
    keywords: Array.isArray(l.keywords) ? l.keywords.map(String).slice(0, 12) : [],
    };
  });
  let ex = ensureStandardMccbAccessories(extracted, inputText);
  ex = ensureFeederIndication(ex, inputText);
  inheritLampVoltage(ex); // fixes any injected indication lamp left without a voltage
  return ex;
}

/**
 * Indicator lamps in a panel run off one common control voltage. A line that
 * omits its lamp voltage (e.g. "RYB indicating lamps of LED module …", where the
 * only voltage stated belongs to the accompanying MCB) should inherit the voltage
 * the panel's OTHER lamps do state — otherwise retrieval, having no voltage to
 * match, falls to the lowest catalog variant (e.g. a 12 VAC/DC lamp). We take the
 * most common stated lamp voltage FROM the document (not a hardcoded default).
 */
function inheritLampVoltage(reqs: Requirement[]): void {
  const isLamp = (r: Requirement) =>
    /indicat|lamp|\bled\b|pilot/i.test(`${r.requirement} ${r.keywords.join(' ')}`);
  const lamps = reqs.filter(isLamp);
  const counts = new Map<string, number>();
  for (const l of lamps) if (l.voltage) counts.set(l.voltage, (counts.get(l.voltage) ?? 0) + 1);
  if (counts.size === 0) return; // no lamp states a voltage — nothing to inherit
  const mode = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]![0];
  for (const l of lamps) if (!l.voltage) l.voltage = mode;
}

/**
 * ==========================================================================
 *  MCCB ACCESSORY BUNDLES — the "associate items" that ship with an MCCB.
 * ==========================================================================
 * THIS is the mapping. It mirrors the customer's "MCCB ACCS" reference sheet:
 * every MCCB carries a base pair (spreader link + extended rotary handle), and
 * a named variant adds one more accessory depending on the control scheme:
 *
 *   MCCB ACCS (base)                 → Spreader link, Extended rotary handle
 *   MCCB ACCS for production relays  → + Shunt coil
 *   MCCB ACCS for electrical interlock → + Under-voltage coil
 *   MCCB ACCS for on/off/trip        → + Auxiliary & trip contact
 *
 * A BOQ SELECTS the variant by naming it in its text (e.g. the metering note
 * "ON,OFF,TRIP indication required" → the on/off/trip bundle). We then attach
 * that bundle's accessories to EVERY MCCB, each resolved to the SAME frame /
 * ampere as its parent breaker (by resolveAccessoryByFrame downstream). Purely
 * FUNCTION-based — no brand/catalog named — so it works for any price list.
 */
type AccKey = 'spreader' | 'handle' | 'aux' | 'shunt' | 'uv' | 'gf';
const ACC_DEFS: Record<AccKey, { requirement: string; keywords: string[] }> = {
  spreader: { requirement: 'Spreader terminals', keywords: ['spreader', 'terminal'] },
  handle: { requirement: 'Extended rotary handle', keywords: ['extended', 'rotary', 'handle'] },
  aux: { requirement: 'Auxiliary & trip-alarm contact', keywords: ['auxiliary', 'trip', 'contact'] },
  shunt: { requirement: 'Shunt release', keywords: ['shunt', 'release'] },
  uv: { requirement: 'Under-voltage release', keywords: ['under', 'voltage', 'release'] },
  gf: { requirement: 'Ground fault module', keywords: ['ground', 'fault', 'module'] },
};

/** Recognises an accessory of each kind in an already-extracted child line. */
const ACC_PRESENT: Record<AccKey, RegExp> = {
  spreader: /spreader/,
  handle: /rotary|operating\s*handle|door\s*interlock|\brom\b/,
  aux: /auxiliary|aux\b|trip\s*alarm|signal/,
  shunt: /shunt/,
  uv: /under[\s-]*voltage|\buv\b/,
  gf: /ground\s*fault|earth\s*fault|\bgf\b/,
};

/** The base accessories every MCCB gets in any bundle. */
const BASE_BUNDLE: AccKey[] = ['spreader', 'handle'];

/** Named bundles — matched against the BOQ text; first match wins. */
const MCCB_ACCESSORY_BUNDLES: { name: string; mention: RegExp; items: AccKey[] }[] = [
  { name: 'on/off/trip', mention: /on\s*[,/\-]?\s*off\s*[,/\-]?\s*trip/i, items: [...BASE_BUNDLE, 'aux'] },
  { name: 'electrical interlock', mention: /electric(?:al)?\s*interlock/i, items: [...BASE_BUNDLE, 'uv'] },
  { name: 'production relays', mention: /production\s*relay/i, items: [...BASE_BUNDLE, 'shunt'] },
];

/** Fallback (no bundle named): attach each accessory only if the BOQ mentions it. */
const INDIVIDUAL_MENTION: Partial<Record<AccKey, RegExp>> = {
  aux: /auxiliary\s*contact|aux\.?\s*contact|signal(?:ling)?\s*contact|trip\s*alarm/i,
  shunt: /shunt\s*(?:release|trip|coil)/i,
  uv: /under[\s-]*voltage/i,
  spreader: /spreader/i,
  handle: /rotary\s*handle|operating\s*handle|door\s*interlock/i,
};

export function ensureStandardMccbAccessories(reqs: Requirement[], docText = ''): Requirement[] {
  const doc = docText.toLowerCase();
  const isMccb = (r: Requirement): boolean =>
    !r.isAccessory &&
    (/\bMCCB\b/i.test(r.requirement) || r.keywords.some((k) => /mccb/i.test(k)));

  // Which named bundle did the BOQ ask for? (on/off/trip, interlock, production relays)
  const bundle = MCCB_ACCESSORY_BUNDLES.find((b) => b.mention.test(doc));
  // Ground fault is independent of the bundle — attach it whenever the BOQ says so.
  const wantsGf = /ground\s*fault|earth\s*fault/i.test(doc);

  const out = [...reqs];
  let nextLine = reqs.reduce((m, r) => Math.max(m, r.lineNo), 0) + 1;

  for (const b of reqs) {
    if (!isMccb(b)) continue;
    const childrenSig = reqs
      .filter((r) => r.isAccessory && r.parentLineNo === b.lineNo)
      .map((r) => `${r.requirement} ${r.keywords.join(' ')}`.toLowerCase());

    const attach = (key: AccKey) => {
      const def = ACC_DEFS[key];
      const kws = key === 'gf' && b.ratingAmp ? def.keywords : def.keywords;
      // Already emitted by the extraction (from the BOQ or a brand rule) under this
      // breaker — in any wording ("Spreader link", "Spreader terminals").
      const already = childrenSig.some((s) => ACC_PRESENT[key].test(s));
      if (already) return;
      out.push({
        lineNo: nextLine++,
        requirement: key === 'gf' && b.ratingAmp ? `${def.requirement} for ${b.ratingAmp}A MCCB` : def.requirement,
        quantity: b.quantity, // resolveQuantity derives from the parent breaker anyway
        panelQty: b.panelQty,
        isAccessory: true,
        parentLineNo: b.lineNo,
        board: b.board, // accessory sits under its breaker's board in the feeder BOM
        ratingAmp: b.ratingAmp, // carried so a rating-scoped accessory (GF1/GF2, frame) resolves
        poles: b.poles, // spreader/handle come in pole variants — keep the parent's pole count
        breakingKa: null,
        releaseType: null,
        construction: null,
        protection: null,
        voltage: null,
        variant: null,
        feederRole: b.feederRole,
        keywords: kws,
      });
    };

    // 1) The named bundle → every accessory in it, on this MCCB.
    if (bundle) {
      for (const key of bundle.items) attach(key);
    } else {
      // 2) No bundle named → attach only the accessories the BOQ individually mentions.
      for (const key of Object.keys(INDIVIDUAL_MENTION) as AccKey[]) {
        if (INDIVIDUAL_MENTION[key]!.test(doc)) attach(key);
      }
    }
    // 3) Ground-fault module — independent of the bundle.
    if (wantsGf) attach('gf');
  }
  return out;
}

/**
 * Step 1b — RULE-DRIVEN ACCESSORIES. A focused AI call whose main content is the
 * brand rules (and the customer's instructions): for every breaker the extraction
 * found, it lists the accessories those rules make mandatory ("every MCCB gets an
 * extended rotary handle and a pole-matched spreader link") or conditional
 * ("LSIG on 3P → external neutral CT + adaptor kit"), and flags accessories already
 * on the line that the rules say are NOT required (e.g. a ground-fault module on a
 * 4P breaker whose release has ground fault built in).
 *
 * This exists because the rules were previously a footnote at the end of the
 * ~11k-token extraction prompt and the model kept to the BOQ's literal lines.
 * Here the rules ARE the task. Nothing is hard-coded: with no rules and no
 * instructions the step is skipped and the lines pass through unchanged.
 */
export async function applyRuleAccessories(
  provider: LlmProvider,
  reqs: Requirement[],
  guidance: { brandNotes: string; customerNotes: string },
): Promise<Requirement[]> {
  const brandNotes = guidance.brandNotes.trim();
  const customerNotes = guidance.customerNotes.trim();
  if (!brandNotes && !customerNotes) return reqs;
  // Only rated devices (breakers, switches, starters) carry accessories.
  const devices = reqs.filter((r) => !r.isAccessory && r.ratingAmp != null);
  if (!devices.length) return reqs;

  const payload = devices.map((d) => ({
    lineNo: d.lineNo,
    requirement: d.requirement,
    ratingAmp: d.ratingAmp,
    poles: d.poles,
    breakingKa: d.breakingKa,
    releaseType: d.releaseType,
    construction: d.construction,
    protection: d.protection,
    feederRole: d.feederRole,
    board: d.board,
    quantity: d.quantity,
    accessories: reqs
      .filter((a) => a.isAccessory && a.parentLineNo === d.lineNo)
      .map((a) => ({ lineNo: a.lineNo, requirement: a.requirement })),
  }));

  const system = [
    await getPromptText('quote.accessories.system'),
    ...(brandNotes ? ['', 'BRAND RULES:', brandNotes] : []),
    ...(customerNotes ? ['', 'CUSTOMER INSTRUCTIONS:', customerNotes] : []),
  ].join('\n');

  const raw = await provider.complete(
    [{ role: 'user', content: `Breakers:\n${JSON.stringify(payload)}` }],
    { system, json: true, maxTokens: 6000, label: 'quote:accessories' },
  );
  type Out = {
    breakers?: {
      lineNo: number;
      add?: { requirement: string; keywords?: string[]; quantity?: number; reason?: string }[];
      remove?: { lineNo: number; reason?: string }[];
    }[];
  };
  const parsed = parseJson<Out>(raw);
  const byLine = new Map(reqs.map((r) => [r.lineNo, r]));
  const removed = new Set<number>();
  const added: Requirement[] = [];
  let nextLine = reqs.reduce((m, r) => Math.max(m, r.lineNo), 0) + 1;
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

  for (const b of parsed.breakers ?? []) {
    const parent = byLine.get(Number(b.lineNo));
    if (!parent || parent.isAccessory) continue;
    for (const rm of b.remove ?? []) {
      const child = byLine.get(Number(rm.lineNo));
      if (child?.isAccessory && child.parentLineNo === parent.lineNo) removed.add(child.lineNo);
    }
    const existing = reqs
      .filter((a) => a.isAccessory && a.parentLineNo === parent.lineNo && !removed.has(a.lineNo))
      .map((a) => norm(a.requirement));
    for (const add of b.add ?? []) {
      const requirement = String(add.requirement ?? '').trim().slice(0, 200);
      if (!requirement) continue;
      const n = norm(requirement);
      // Same accessory already there (in any wording) → skip, never duplicate.
      if (existing.some((e) => e === n || e.includes(n) || n.includes(e))) continue;
      existing.push(n);
      const perBreaker = Number(add.quantity) > 0 ? Math.round(Number(add.quantity)) : 1;
      added.push({
        lineNo: nextLine++,
        requirement,
        quantity: perBreaker * parent.quantity,
        panelQty: parent.panelQty,
        isAccessory: true,
        parentLineNo: parent.lineNo,
        board: parent.board,
        ratingAmp: parent.ratingAmp, // a frame/rating-scoped accessory resolves to the parent's frame
        poles: parent.poles, // pole-specific accessories (spreader, handle) keep the parent's poles
        breakingKa: null,
        releaseType: null,
        construction: null,
        protection: null,
        voltage: null,
        variant: null,
        feederRole: parent.feederRole,
        keywords: Array.isArray(add.keywords)
          ? add.keywords.map((k) => String(k).toLowerCase()).slice(0, 8)
          : n.split(' ').slice(0, 5),
      });
    }
  }
  return [...reqs.filter((r) => !removed.has(r.lineNo)), ...added];
}

/** Detect the panel's control/indication voltage (L-N of the supply). */
function controlVoltage(docText: string): string | null {
  const m = /(\d{3})\s*V\s*\(?\s*L\s*-?\s*N/i.exec(docText);
  if (m) return `${m[1]}VAC`;
  if (/\b240\s*V\b/i.test(docText)) return '240VAC';
  // A 415V 3-phase system's line-to-neutral (control) voltage is 240V.
  if (/\b415\s*V\b/i.test(docText)) return '240VAC';
  return null;
}

/**
 * Per-feeder indication explosion. A real switchgear BOM repeats the indication
 * lamps + a control MCB under EVERY feeder, not once for the panel. The BOQ says
 * which: e.g. "R,Y,B and ON,OFF,TRIP … for Incomer", "ON,OFF,TRIP … for Outgoing".
 * Incomer(s) get the phase set (R,Y,B) plus the state set (R,G,A) — merged to the
 * distinct colours R,Y,B,G,A; every outgoing gets the state set R,G,A. Each lamp
 * and one 6A control MCB is attached to its MCCB (parentLineNo) so it nests under
 * that feeder in the BOM. Incomer = the highest-rated MCCB in its board.
 */
export function ensureFeederIndication(reqs: Requirement[], docText = ''): Requirement[] {
  const wantRYB = /\br\s*[,/]?\s*y\s*[,/]?\s*b\b/i.test(docText);
  const wantState = /on\s*[,/]?\s*off\s*[,/]?\s*trip/i.test(docText);
  if (!wantRYB && !wantState) return reqs;

  const isMccb = (r: Requirement) =>
    !r.isAccessory && (/\bMCCB\b/i.test(r.requirement) || r.keywords.some((k) => /mccb/i.test(k)));
  const mccbs = reqs.filter(isMccb);
  if (!mccbs.length) return reqs;

  // Incomer = the highest-rated MCCB in each board (or one whose text says "incom").
  const maxByBoard = new Map<string, number>();
  for (const m of mccbs) {
    const b = m.board ?? '';
    maxByBoard.set(b, Math.max(maxByBoard.get(b) ?? 0, m.ratingAmp ?? 0));
  }
  const isIncomer = (m: Requirement) =>
    m.feederRole === 'incoming' ||
    (m.feederRole !== 'outgoing' && /\bincom|i\/c\b/i.test(m.requirement)) ||
    (m.ratingAmp != null && m.ratingAmp === maxByBoard.get(m.board ?? ''));

  const cv = controlVoltage(docText);
  const PHASE = ['Red', 'Yellow', 'Blue'];
  const STATE = ['Red', 'Green', 'Amber'];
  const out = [...reqs];
  let nextLine = reqs.reduce((mx, r) => Math.max(mx, r.lineNo), 0) + 1;

  for (const m of mccbs) {
    const colours = new Set<string>();
    if (isIncomer(m) && wantRYB) PHASE.forEach((c) => colours.add(c));
    if (wantState) STATE.forEach((c) => colours.add(c));
    // Don't double-inject if the LLM already emitted lamps for this MCCB.
    const existing = reqs
      .filter((r) => r.isAccessory && r.parentLineNo === m.lineNo)
      .map((r) => `${r.requirement} ${r.variant ?? ''}`.toLowerCase());
    for (const colour of colours) {
      if (existing.some((s) => s.includes(colour.toLowerCase()) && /lamp|indicat|led/.test(s))) continue;
      out.push({
        lineNo: nextLine++,
        requirement: `${colour} indication lamp`,
        quantity: 1,
        panelQty: m.panelQty,
        isAccessory: true,
        parentLineNo: m.lineNo,
        board: m.board,
        ratingAmp: null,
        poles: null,
        breakingKa: null,
        releaseType: null,
        construction: null,
        protection: null,
        voltage: cv,
        variant: colour,
        feederRole: m.feederRole,
        keywords: ['led', 'indicator', 'lamp', colour.toLowerCase()],
      });
    }
    // One 6A control MCB per feeder (for the indication/measuring circuit).
    if (!existing.some((s) => /\bmcb\b/.test(s))) {
      out.push({
        lineNo: nextLine++,
        requirement: '6A SP MCB (control)',
        quantity: 1,
        panelQty: m.panelQty,
        isAccessory: true,
        parentLineNo: m.lineNo,
        board: m.board,
        ratingAmp: 6,
        poles: 1,
        breakingKa: null,
        releaseType: null,
        construction: null,
        protection: null,
        voltage: null,
        variant: null,
        feederRole: m.feederRole,
        keywords: ['mcb', 'single', 'pole', '6a'],
      });
    }
  }
  return out;
}

/** Rows that are notes/footnotes, not real products — never valid candidates. */
const JUNK_ROW = /^\s*(note|general|special applications|available till|breaking capacity\s*:)/i;

function isRealProduct(item: PriceListItem): boolean {
  const fam = (item.family ?? '').trim();
  const desc = (item.description ?? '').trim();
  if (JUNK_ROW.test(fam) || JUNK_ROW.test(desc)) return false;
  return desc.length > 0 || item.ratingAmp != null;
}

/** How far (in catalogue pages) an accessory may sit from the quoted products. */
const ACCESSORY_PAGE_WINDOW = 15;

/**
 * Series stems of the quoted breakers, from their type/description — e.g.
 * DN0-100C / DN2-250D → ["dn0","dn2"]. Used to keep an accessory on the same
 * product series (a DN breaker's aux contact, not a DZ or DN4 one).
 */
export function deriveSeries(
  candidates: Map<number, PriceListItem[]>,
  requirements: Requirement[],
): string[] {
  const stems = new Set<string>();
  for (const r of requirements) {
    if (r.isAccessory) continue;
    const top = (candidates.get(r.lineNo) ?? [])[0];
    for (const s of seriesStems(`${top?.type ?? ''} ${top?.description ?? ''}`)) stems.add(s);
  }
  return [...stems];
}

/** Series stems (e.g. "dn0","dn2","dz3") in a type/description string. Brand-agnostic. */
function seriesStems(src: string): string[] {
  const stems = new Set<string>();
  for (const m of src.matchAll(/\b([A-Z]{2}\d)\b/g)) if (m[1]) stems.add(m[1].toLowerCase());
  return [...stems];
}

/**
 * Step 2 — build a requirement → candidate map from the loaded price-list pool.
 *
 * Primary (rated) items are matched first; accessories are then constrained to
 * the pages near those primary items. Catalogues group a product's accessories
 * next to the product, so this keeps an MCCB's accessories from being matched to
 * a different product line's aux-contact/shunt/handle that merely shares the
 * same words (the main source of wrong accessory picks).
 */
export function retrieveCandidates(
  pool: PriceListItem[],
  requirements: Requirement[],
): Map<number, PriceListItem[]> {
  const clean = pool.filter(isRealProduct);
  const byLine = new Map<number, PriceListItem[]>();

  // Pass 1 — primary (non-accessory) lines, matched against the whole pool.
  const primaryPages: number[] = [];
  for (const r of requirements) {
    if (r.isAccessory) continue;
    const ranked = rankCandidates(clean, {
      ratingAmp: r.ratingAmp,
      poles: r.poles,
      breakingKa: r.breakingKa,
      keywords: r.keywords,
      voltage: r.voltage,
      // Wider set so release-type / series variants of the same rating all survive
      // for the model to choose the correct one (thermal-magnetic vs microprocessor
      // vs a basic DU/DY series that shares the rating).
      limit: 14,
    });
    byLine.set(r.lineNo, ranked.map((c) => c.item));
    const p = ranked[0]?.item.pageNo;
    if (p != null) primaryPages.push(p);
  }

  // Page window derived from where the primary items actually matched.
  const lo = primaryPages.length ? Math.min(...primaryPages) - ACCESSORY_PAGE_WINDOW : -Infinity;
  const hi = primaryPages.length ? Math.max(...primaryPages) + ACCESSORY_PAGE_WINDOW : Infinity;

  // Series stems of ALL matched breakers — the fallback bias for an accessory
  // whose parent breaker we can't pin down.
  const allSeries = deriveSeries(byLine, requirements);
  const reqByLine = new Map(requirements.map((r) => [r.lineNo, r]));

  // Pass 2 — accessory lines, restricted to the primary items' page neighbourhood.
  for (const r of requirements) {
    if (!r.isAccessory) continue;
    const nearby = clean.filter((i) => i.pageNo == null || (i.pageNo >= lo && i.pageNo <= hi));
    // Prefer the accessory's PARENT breaker's own series so a DN0 breaker's handle
    // retrieves the DN0 handle — not the DN3 one — instead of every quoted series
    // biasing every accessory equally. Fall back to all series when the parent is
    // unknown. (Additive keyword bias, never a hard filter, so it can't drop a
    // valid accessory whose row simply omits the series token.)
    const parent = r.parentLineNo != null ? reqByLine.get(r.parentLineNo) : undefined;
    const parentTop = parent && !parent.isAccessory ? (byLine.get(parent.lineNo) ?? [])[0] : undefined;
    const parentSeries = parentTop
      ? seriesStems(`${parentTop.type ?? ''} ${parentTop.description ?? ''}`)
      : [];
    const seriesBias = parentSeries.length ? parentSeries : allSeries;
    // Standalone products attached to a feeder (indication lamps, control MCB) are
    // NOT frame accessories and live on unrelated pages, so search the FULL pool and
    // match on their own rating/voltage rather than the parent breaker's page window.
    const standalone = r.keywords.some((k) => /\b(led|indicator|lamp|pilot|mcb)\b/i.test(k));
    const ranked = standalone
      ? rankCandidates(clean, {
          keywords: r.keywords,
          ratingAmp: r.ratingAmp,
          poles: r.poles,
          voltage: r.voltage,
          limit: 8,
        })
      : rankCandidates(nearby, { keywords: [...r.keywords, ...seriesBias], limit: 8 });
    byLine.set(r.lineNo, ranked.map((c) => c.item));
  }

  return byLine;
}

/** Step 3 — ask the model to pick the best catalog number per line. */
/** Candidates shown to the matcher per line (retrieval keeps more internally). */
const MATCH_CANDIDATES = 8;
/** Requirement lines per LLM match call — keeps each request under the TPM cap. */
const MATCH_BATCH = 5;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Everything the user supplied that must steer the catalog choice, besides the
 * BOQ itself: the brand rules picked for the chat, what the customer typed, and
 * a lookup into the brands' reference files. All optional.
 */
export interface MatchGuidance {
  /** The selected brand keyword prompts (rules), as text. */
  brandNotes?: string;
  /** The customer's own instructions typed with the BOQ. */
  customerNotes?: string;
  /** Finds reference-file passages for a batch of requirement texts. */
  retrieveReference?: (query: string) => Promise<{ file: string; text: string }[]>;
  /** Called before each batch with its 1-based number and the batch count. */
  onBatch?: (batch: number, total: number) => void;
  /** Every requirement of the quote (set by matchRequirements) — batch context. */
  allRequirements?: Requirement[];
}

export async function matchRequirements(
  provider: LlmProvider,
  requirements: Requirement[],
  candidates: Map<number, PriceListItem[]>,
  targetSeries: string[] = [],
  guidance: MatchGuidance = {},
): Promise<MatchDecision[]> {
  // Process in small batches so a big BOQ never exceeds the token-per-minute cap.
  const out: MatchDecision[] = [];
  const batches = Math.ceil(requirements.length / MATCH_BATCH);
  const ctx: MatchGuidance = { ...guidance, allRequirements: requirements };
  for (let i = 0; i < requirements.length; i += MATCH_BATCH) {
    const batch = requirements.slice(i, i + MATCH_BATCH);
    guidance.onBatch?.(i / MATCH_BATCH + 1, batches);
    // Reference-file passages that match THIS batch's lines (free keyword lookup).
    const refs = guidance.retrieveReference
      ? await guidance.retrieveReference(batch.map((r) => r.requirement).join(' '))
      : [];
    out.push(...(await matchBatch(provider, batch, candidates, targetSeries, ctx, refs)));
    if (i + MATCH_BATCH < requirements.length) await sleep(2500); // pace vs TPM
  }
  return out;
}

async function matchBatch(
  provider: LlmProvider,
  requirements: Requirement[],
  candidates: Map<number, PriceListItem[]>,
  targetSeries: string[],
  guidance: MatchGuidance,
  refs: { file: string; text: string }[],
): Promise<MatchDecision[]> {
  const brandNotes = guidance.brandNotes?.trim() ?? '';
  const customerNotes = guidance.customerNotes?.trim() ?? '';
  // Compact payload: only the fields the model needs to choose.
  const payload = requirements.map((r) => ({
    lineNo: r.lineNo,
    requirement: r.requirement,
    ratingAmp: r.ratingAmp,
    poles: r.poles,
    breakingKa: r.breakingKa,
    releaseType: r.releaseType,
    // The BOQ's construction / protection words and the feeder role go with the
    // line so the brand rules ("double-break → …", "LSIG → …", "incoming → …")
    // can actually be applied to it.
    construction: r.construction,
    protection: r.protection,
    feederRole: r.feederRole,
    candidates: (candidates.get(r.lineNo) ?? []).slice(0, MATCH_CANDIDATES).map((c) => ({
      catalogNo: c.catalogNo,
      description: c.description, // includes the release type (e.g. "Thermal-Magnetic Release")
      family: c.family,
      type: c.type,
      poles: c.poles,
      ratingAmp: c.ratingAmp != null ? Number(c.ratingAmp) : null,
      breakingKa: c.breakingKa != null ? Number(c.breakingKa) : null,
      listPrice: Number(c.listPrice),
    })),
  }));

  const system = [
    await getPromptText('quote.match.system'),
    ...(targetSeries.length
      ? [
          `ACCESSORY lines only: the quote's breakers are from the ${targetSeries.join('/').toUpperCase()}`,
          'series, so an accessory must be for its parent breaker\'s series; if its only',
          'candidates are for a different series, return null rather than a wrong-series',
          'part. (This list says nothing about which series a BREAKER line must be.)',
        ]
      : []),
    ...(brandNotes
      ? [
          '',
          "BRAND RULES (the user's saved keyword prompts for the quoted brand — use them to",
          'interpret the requirement and to choose between candidates; rule 1 still holds, so',
          'only ever pick a catalogNo from that line\'s candidates):',
          brandNotes,
        ]
      : []),
    ...(customerNotes
      ? [
          '',
          'CUSTOMER INSTRUCTIONS (typed by the user with this BOQ — follow them when choosing,',
          'within rule 1):',
          customerNotes,
        ]
      : []),
    ...(refs.length
      ? [
          '',
          "REFERENCE TEXT (passages from the brand's reference files that mention these",
          'items — product notes, ordering codes, series descriptions; use them to understand',
          'the products, never as a source of catalog numbers outside the candidates):',
          ...refs.map((s) => `--- ${s.file} ---\n${s.text}`),
        ]
      : []),
  ].join('\n');
  // Every breaker of the whole quote with its BOQ facts, so a 5-line batch applies
  // the series rule exactly as the other batches do (same facts → same series).
  const allBreakers = (guidance.allRequirements ?? requirements)
    .filter((r) => !r.isAccessory && r.ratingAmp != null)
    .map((r) => ({
      lineNo: r.lineNo,
      requirement: r.requirement,
      ratingAmp: r.ratingAmp,
      poles: r.poles,
      releaseType: r.releaseType,
      construction: r.construction,
      protection: r.protection,
      feederRole: r.feederRole,
    }));
  const user =
    `ALL BREAKERS of this quote (context only — match just the lines below):\n${JSON.stringify(allBreakers)}\n\n` +
    `Lines with candidates:\n${JSON.stringify(payload)}\n\n` +
    'Return {"matches": [{ "lineNo": number, "catalogNo": string|null, ' +
    '"confidence": number, "reason": string }]}. For a breaker the reason must name ' +
    'the series the rules allowed for it and why (construction / protection / role ' +
    'fact → rule), then the row chosen.';

  const raw = await provider.complete([{ role: 'user', content: user }], {
    system,
    json: true,
    maxTokens: 6000,
    label: 'quote:match',
  });
  const parsed = parseJson<{ matches?: MatchDecision[] }>(raw);
  return parsed.matches ?? [];
}

/** Step 4 — deterministic pricing. Never delegated to the model. */
export function priceLines(
  requirements: Requirement[],
  matches: MatchDecision[],
  candidates: Map<number, PriceListItem[]>,
  defaultDiscountPct: number,
  fullPool: PriceListItem[] = [],
): PricedLine[] {
  const matchByLine = new Map(matches.map((m) => [m.lineNo, m]));
  // Deterministic accessory resolvers search the WHOLE brand pool (not just a
  // line's retrieved top-N) so they can always reach the correct catalog.
  const searchPool = (lineNo: number): PriceListItem[] =>
    fullPool.length ? fullPool : candidates.get(lineNo) ?? [];
  const reqByLine = new Map(requirements.map((r) => [r.lineNo, r]));

  /**
   * Strict rule: an accessory is quoted once per parent breaker, so its quantity
   * is ALWAYS the parent breaker's quantity — never a number the model guessed
   * for the aggregate (which is where inflated 42/45/60 counts came from). A
   * parent is valid only if it exists and is itself a (non-accessory) breaker.
   * An accessory with no valid parent can't have its quantity derived, so it is
   * neutralised to 1 and flagged for review rather than trusting a bad count.
   */
  function resolveQuantity(r: Requirement): { quantity: number; note: string } {
    if (!r.isAccessory) return { quantity: r.quantity, note: '' };
    const parent = r.parentLineNo != null ? reqByLine.get(r.parentLineNo) : undefined;
    if (parent && !parent.isAccessory) return { quantity: parent.quantity, note: '' };
    return {
      quantity: 1,
      note: 'Accessory has no parent breaker — quantity not derived, review qty.',
    };
  }

  /**
   * MCB/RCCB trip-curve normalisation. LK MCB catalog numbers encode the curve
   * as the trailing letter (…B / …C / …D). The three variants share an identical
   * description ("6A, 1P, MCB"), so the matcher cannot tell them apart and may
   * grab the B-curve arbitrarily. When the requirement names no curve, the
   * standard default for mixed distribution boards is C-curve — which is also
   * what the reference quotes use — so swap to the same-rating C-curve sibling
   * when one exists in the candidate pool.
   */
  function preferDefaultCurve(
    item: PriceListItem | null,
    r: Requirement,
    pool: PriceListItem[],
  ): PriceListItem | null {
    if (!item) return item;
    const tag = `${item.family ?? ''} ${item.type ?? ''} ${item.description ?? ''}`;
    const isMcb = /\bMCB\b|Miniature Circuit Breaker/i.test(tag) && !/MCCB/i.test(tag);
    if (!isMcb) return item;
    if (/\b[BCD][- ]?curve\b|\bcurve\s*[BCD]\b|\btype\s*[BCD]\b/i.test(r.requirement || '')) return item;
    const m = /^(.*?)([BD])$/.exec(item.catalogNo || '');
    if (!m) return item;
    const sibling = pool.find((c) => c.catalogNo === m[1] + 'C');
    return sibling ?? item;
  }

  /** First frame/series stem in a string, e.g. "DN0-100C" | "… DN2 Extended ROM" → "dn0"/"dn2". */
  const frameStem = (s: string): string | null => {
    const m = /\bD[NUZY]\d/i.exec(s || '');
    return m ? m[0].toLowerCase() : null;
  };
  /** Accessory description reduced to its FUNCTION (frames/ratings/punctuation
   *  stripped). Drops ANY token containing a digit (dn0, 125d, 250, 415v …) so
   *  two frame variants of the same accessory share a signature. */
  const funcSig = (s: string | null): string =>
    (s ?? '')
      .toLowerCase()
      .replace(/\b\w*\d\w*\b/g, ' ')
      .replace(/[^a-z ]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();

  /** Coarse accessory FUNCTION class (so frame variants with different wording
   *  still count as the same accessory). Derived from a description or keywords. */
  const accClass = (s: string): string | null => {
    const d = s.toLowerCase();
    if (/ground fault/.test(d)) return 'gf';
    if (/spreader/.test(d)) return 'spreader';
    // A door key-lock "for Extended ROM" is a lock, not the handle itself.
    if (/key\s*lock|padlock|locking device/.test(d)) return 'lock';
    if (/rotary handle|extended rom|direct rom|operating handle/.test(d)) return 'rotary';
    if (/shunt/.test(d)) return 'shunt';
    if (/under voltage|uv release/.test(d)) return 'uv';
    if (/trip alarm/.test(d)) return 'tripalarm';
    if (/auxiliary|aux\b/.test(d)) return 'aux';
    return null;
  };

  /**
   * Deterministic accessory selection by the PARENT breaker's frame + the
   * variant the requirement asks for (AC coil, +TAC, extended handle, N-pole).
   * Keys off the parent's FINAL frame authoritatively — not the model's own
   * (often wrong-frame) pick — and matches by FUNCTION CLASS, so shunt/aux
   * variants whose wording differs across frames are still corrected. Works even
   * when the model matched nothing. GF is handled separately (by rating range).
   */
  function resolveAccessoryByFrame(item: PriceListItem | null, r: Requirement): PriceListItem | null {
    if (!r.isAccessory || r.parentLineNo == null) return item;
    const parent = reqByLine.get(r.parentLineNo);
    if (!parent || parent.isAccessory) return item;
    const parentItem = resolvedItem.get(parent.lineNo) ?? null;
    const parentTag = `${parentItem?.type ?? ''} ${parentItem?.description ?? ''}`;
    const parentFrame = frameStem(parentTag); // base stem, e.g. "dn3"
    if (!parentFrame) return item;
    // The rating-specific frame, e.g. "dn3-630" from a "DN3-630D" breaker. We
    // prefer an accessory that names the FULL frame (a DN3-630 spreader), then
    // fall back to the base stem (handles/aux are catalogued as just "DN3"/"DN0").
    const parentFrameFull = /\bD[NUZY]\d-\d+/i.exec(parentTag)?.[0].toLowerCase() ?? null;
    // Derive the accessory's class from what it IS (its requirement/keywords),
    // NOT from the model's matched item — a mis-match (e.g. a UV release picked for
    // a spreader line) would otherwise flip the class and resolve the wrong part.
    const cls = accClass(`${r.requirement} ${r.keywords.join(' ')}`) ?? accClass(item?.description ?? '');
    if (!cls || cls === 'gf') return item; // GF resolved by pickGroundFault
    const kw = r.keywords.map((k) => k.toLowerCase());
    const reqText = `${r.requirement} ${kw.join(' ')}`.toLowerCase();
    const wantAc = kw.includes('ac');
    const wantTac = kw.includes('tac');
    // The variant words come from the line's own wording — which the brand rules /
    // BOQ dictated ("Extended rotary handle", "Direct rotary handle").
    const wantExtended = /\bextended\b/.test(reqText);
    const wantDirect = !wantExtended && /\bdirect\b/.test(reqText);
    // Pole-specific accessories (spreader links etc.) follow the breaker's pole
    // count: stated on the line ("4 pole", "4p") or inherited from the parent.
    const wantPole =
      /\b(\d)\s*(?:pole|p)\b/.exec(reqText)?.[1] ?? (r.poles != null ? String(r.poles) : undefined);
    const ok = (cd: string, frame: string): boolean => {
      const cdPole = /\b(\d)\s*pole\b/.exec(cd)?.[1];
      // The section heading can list both variants — "Rotary Mechanism
      // (Direct/Extended) — DZ7 Direct ROM" — so judge the variant on the row's own
      // name with parenthesised heading text removed.
      const cdVariant = cd.replace(/\([^)]*\)/g, ' ');
      return (
        accClass(cd) === cls &&
        cd.includes(frame) &&
        (!wantAc || /\bac\b/.test(cd)) &&
        (!wantTac || /\+\s*tac|\btac\b/.test(cd)) &&
        (!wantExtended || /extended/.test(cdVariant)) &&
        (!wantDirect || /direct/.test(cdVariant)) &&
        // Only pole-variant catalogue rows are checked for the pole count; a row
        // with no pole in its name fits any breaker.
        (!wantPole || cdPole == null || cdPole === wantPole)
      );
    };
    const itemDesc = (item?.description ?? '').toLowerCase();
    // Keep the current pick only if it already matches the SPECIFIC frame (best),
    // or matches the base and no specific-frame candidate exists.
    const pool = searchPool(r.lineNo);
    const bySpecific = parentFrameFull
      ? pool.find((c) => ok((c.description ?? '').toLowerCase(), parentFrameFull))
      : undefined;
    if (item && parentFrameFull && ok(itemDesc, parentFrameFull)) return item;
    if (bySpecific) return bySpecific;
    if (item && ok(itemDesc, parentFrame)) return item; // already correct at base frame
    const byBase = pool.find((c) => ok((c.description ?? '').toLowerCase(), parentFrame));
    return byBase ?? item;
  }

  /**
   * Deterministic ground-fault module selection. GF modules are rating-RANGE
   * variants (GF1 100-200A, GF2 200-400A, GF11 up to 800A) that the LLM matched
   * inconsistently. For a ground-fault accessory line, pick — in code, ignoring
   * the model — the module whose range covers the parent breaker's rating (the
   * tightest one whose max ≥ rating; the largest if the rating exceeds them all).
   * Runs even when the model matched nothing, so GF is always resolved.
   */
  function pickGroundFault(item: PriceListItem | null, r: Requirement, pool: PriceListItem[]): PriceListItem | null {
    if (!r.isAccessory) return item;
    const isGf =
      /ground\s*fault/i.test(r.requirement) || r.keywords.some((k) => /ground|fault/i.test(k));
    if (!isGf) return item;
    if (r.ratingAmp == null) return item;
    const ranged = searchPool(r.lineNo)
      .filter((c) => /ground fault/i.test(`${c.family ?? ''} ${c.description ?? ''}`))
      .map((c) => {
        const d = c.description ?? '';
        const rng = /(\d+)\s*-\s*(\d+)\s*a/i.exec(d);
        // GF1/GF2 give an explicit min-max range; GF11 ("up to 800A", external
        // CT) is excluded — that band is covered by the earth-fault relay on the
        // incoming, matching the reference quote (GF1/GF2 only).
        return rng ? { c, min: Number(rng[1]), max: Number(rng[2]) } : null;
      })
      .filter((x): x is { c: PriceListItem; min: number; max: number } => x !== null)
      .sort((a, b) => a.max - b.max);
    // Tightest module whose range covers the breaker rating; none → no GF fitted
    // (breakers below the smallest range or above the largest get no module).
    const cover = ranged.find((x) => r.ratingAmp! >= x.min && r.ratingAmp! <= x.max);
    return cover ? cover.c : null;
  }

  /**
   * 125A dsine MCCBs standardise on the DN2-250 frame (as the reference quote
   * does) rather than the cheaper DN0-125 frame, so 125/200/250 share a frame
   * and their accessories group together. Swap to the DN2-250 125A variant.
   */
  function preferStandardFrame(item: PriceListItem | null, r: Requirement): PriceListItem | null {
    if (!item || r.isAccessory || r.ratingAmp !== 125) return item;
    if (!/DN0-125/i.test(`${item.type ?? ''} ${item.description ?? ''}`)) return item;
    const alt = searchPool(r.lineNo).find(
      (c) =>
        Number(c.ratingAmp) === 125 &&
        /DN2-250/i.test(`${c.type ?? ''} ${c.description ?? ''}`) &&
        (item.poles == null || c.poles === item.poles),
    );
    return alt ?? item;
  }


  // Pass A — resolve the final matched item for every breaker FIRST, so an
  // accessory groups by its parent's FINAL frame (after the 125A swap).
  const resolvedItem = new Map<number, PriceListItem | null>();
  for (const r of requirements) {
    const decision = matchByLine.get(r.lineNo);
    const pool = candidates.get(r.lineNo) ?? [];
    // Resolve the matched catalog against the line's candidates first, then the
    // WHOLE pool — so a valid catalog that just wasn't in this line's retrieved
    // top-N still resolves (an unresolved breaker would strand its accessories,
    // which key off the parent's final frame).
    let it = decision?.catalogNo
      ? pool.find((c) => c.catalogNo === decision.catalogNo) ??
        searchPool(r.lineNo).find((c) => c.catalogNo === decision.catalogNo) ??
        null
      : null;
    it = preferDefaultCurve(it, r, pool);
    if (!r.isAccessory) it = preferStandardFrame(it, r);
    resolvedItem.set(r.lineNo, it);
  }

  // Pass B — build the priced lines. Accessories resolve their frame (vs the
  // parent's final item) and their ground-fault module.
  const priced = requirements.map((r) => {
    const decision = matchByLine.get(r.lineNo);
    const pool = candidates.get(r.lineNo) ?? [];
    let item = resolvedItem.get(r.lineNo) ?? null;
    if (r.isAccessory) {
      item = resolveAccessoryByFrame(item, r);
      item = pickGroundFault(item, r, pool);
    }

    const { quantity, note: qtyNote } = resolveQuantity(r);

    const listPrice = item ? Number(item.listPrice) : null;
    const discountPct = defaultDiscountPct;
    const rate = listPrice != null ? round2(listPrice * (1 - discountPct / 100)) : null;
    const amount = rate != null ? round2(rate * quantity) : null;

    const baseNote = decision?.reason ?? (item ? '' : 'No confident match — review required.');
    const matchNote = [baseNote, qtyNote].filter(Boolean).join(' ');
    // An undrivable accessory quantity is a review condition — cap confidence so
    // the review UI surfaces the line even though the catalog match itself is fine.
    const confidence = qtyNote
      ? Math.min(decision?.confidence ?? 0, 0.39)
      : decision?.confidence ?? 0;

    return {
      lineNo: r.lineNo,
      requirement: r.requirement,
      isAccessory: r.isAccessory,
      quantity,
      family: item
        ? /ground fault/i.test(item.description ?? '')
          ? 'MCCB Accessories'
          : cleanFamily(item.family, item.type)
        : null,
      make: item ? item.brand : '',
      type: item?.type ?? null,
      catalogNo: item?.catalogNo ?? null,
      // Append the variant (lamp colour) and voltage to the matched item's
      // description so the quote shows "… — Red, 240VAC" and lines that differ only
      // by such a detail read as distinct, even when they share one catalog number.
      // An unmatched line keeps its BOQ wording as the base so the row never
      // collapses to just "Blue, 240VAC". The Incoming/Outgoing role is NOT part of
      // the description — the BOM shows it once, on the feeder header.
      description: withDetails(item?.description ?? r.requirement, [r.variant, r.voltage]),
      listPrice,
      discountPct,
      rate,
      amount,
      confidence,
      matchNote,
      priceListItemId: item?.id ?? null,
      variant: r.variant ?? null,
      voltage: r.voltage ?? null,
      feederRole: r.feederRole ?? null,
      board: r.board ?? null,
      parentLineNo: r.parentLineNo ?? null,
      lineRef: r.lineNo,
    };
  });

  // Drop ground-fault accessory lines that no module covers (breakers below the
  // smallest GF range, e.g. 63A, or above the largest, e.g. the 630A incoming —
  // which is protected by the earth-fault relay instead).
  return priced.filter((l) => !(l.isAccessory && !l.catalogNo && /ground fault/i.test(l.requirement)));
}

/**
 * Step 5 — consolidate duplicate lines. A BOQ that lists the same breaker in
 * several panels produces repeated lines; merge them into one, summing the
 * quantity and re-deriving the amount. Matched lines merge by catalog number;
 * unmatched (review) lines merge by their requirement text. First-seen order
 * is preserved and line numbers are renumbered.
 */
export function consolidateLines(lines: PricedLine[]): PricedLine[] {
  const byKey = new Map<string, PricedLine>();
  for (const l of lines) {
    // A variant (lamp colour) or voltage keeps otherwise-identical catalog lines
    // apart, so "EPL Red 240VAC" and "EPL Blue 415VAC" stay separate instead of
    // summing into one, while true duplicates (both null) still merge.
    const detailKey = [l.variant, l.voltage]
      .map((d) => (d ? d.trim().toLowerCase() : ''))
      .join('|');
    const key = l.catalogNo
      ? `cat:${l.catalogNo}:${l.discountPct}:${detailKey}`
      : `req:${l.requirement.trim().toLowerCase()}:${detailKey}`;
    const existing = byKey.get(key);
    if (!existing) {
      byKey.set(key, { ...l });
      continue;
    }
    existing.quantity += l.quantity;
    existing.amount =
      existing.rate != null ? round2(existing.rate * existing.quantity) : existing.amount;
    // Keep an accessory tag only if all merged lines agree.
    existing.isAccessory = existing.isAccessory && l.isAccessory;
  }
  return [...byKey.values()].map((l, i) => ({ ...l, lineNo: i + 1 }));
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/**
 * Append distinguishing details (e.g. a lamp colour and its voltage) to a
 * description, skipping any the description already names and de-duplicating.
 * "Gen Next Pro LED Indicator Ø22.5 mm" + ["Red","240VAC"] →
 * "Gen Next Pro LED Indicator Ø22.5 mm — Red, 240VAC".
 */
function withDetails(description: string | null, details: (string | null | undefined)[]): string | null {
  // Whitespace-insensitive so "240VAC" is recognised as already present in a
  // description that writes it "240 VAC" (and vice-versa).
  const norm = (s: string) => s.toLowerCase().replace(/\s+/g, '');
  const hay = description != null ? norm(description) : '';
  const seen = new Set<string>();
  const add: string[] = [];
  for (const raw of details) {
    const v = raw?.trim();
    if (!v) continue;
    const nv = norm(v);
    if (!nv || seen.has(nv)) continue;
    seen.add(nv);
    if (hay.includes(nv)) continue; // already named in the description
    add.push(v);
  }
  if (!add.length) return description;
  if (!description) return add.join(', ');
  return `${description} — ${add.join(', ')}`;
}
