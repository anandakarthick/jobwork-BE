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
}

const EXTRACT_SYSTEM = [
  'You are a quotation engineer for an electrical switchgear supplier. You read a',
  'customer BOQ / specification (often messy, with quantities and ratings embedded',
  'in prose) and produce a clean list of EVERY electrical line item in it.',
  '',
  'SCOPE — extract ALL items, do NOT restrict to one product type: circuit',
  'breakers of every kind (MCCB, MCB, ACB, RCCB, MPCB), their accessories (aux',
  'contact, shunt release, spreader terminal, rotary handle, ground-fault unit),',
  'contactors, overload relays, protection relays, meters (voltmeter/ammeter/MFM),',
  'current transformers, indicating lamps, push buttons, selector switches, timers,',
  'terminals, space heaters, thermostats, etc. Downstream matching keeps only the',
  'items the available brand actually offers and drops the rest — your job is to',
  'capture the FULL requirement list, not to pre-filter by product type or brand.',
  '',
  'QUANTITIES — read them PRECISELY; this is where mistakes happen. Two separate',
  'numbers drive every line, and you must NOT confuse them or multiply them:',
  '  • "quantity" = the per-item count for ONE panel. In a BOQ this count is written',
  '    INSIDE the item description as "1No", "2Nos", "7Nos", "1 Set", "1 Lot" — read',
  '    the integer from there (e.g. "7Nos - 200A …" → 7). A tabular BOQ usually',
  '    leaves the row\'s own Quantity/Qty COLUMN BLANK for these item rows; that',
  '    blank is NOT a quantity — never treat it as 1×nothing, take the count from',
  '    the description text. Default to 1 only when no count is stated anywhere.',
  '  • "panelQty" = how many identical panels this item\'s SECTION belongs to. It',
  '    comes from the nearest PANEL-HEADING row above the item — that heading row',
  '    is the one that carries a number in the Quantity column with a unit like',
  '    "Each"/"Set" (e.g. "8.1 Sub LT Panel 1 … 1 Each" → panelQty 1; "8.2 Sub LT',
  '    Panel 2 & 3 … 2 Each" → panelQty 2). Apply that SAME panelQty to EVERY item',
  '    under that heading (incoming AND outgoing) until the next panel-heading row.',
  'NEVER multiply or sum yourself — report {quantity, panelQty} per line and the',
  'code computes quantity×panelQty and merges same-catalog lines. Emit a SEPARATE',
  'line for EVERY occurrence in EVERY panel/section (a rating that appears as an',
  'Incoming in one panel and an Outgoing in another is a separate line each time;',
  'never drop a panel\'s Incoming breaker).',
  'Worked example from a two-panel BOQ:',
  '  Panel 8.1 (heading Qty col = 1 Each) outgoing "2Nos - 250A" → {quantity:2, panelQty:1}',
  '  Panel 8.2 (heading Qty col = 2 Each) incoming "1No 250A"   → {quantity:1, panelQty:2}',
  '  → code: 2×1 + 1×2 = a total of 4 × 250A. If you had wrongly copied the panel',
  '    heading\'s "2" onto the item, or missed a section, the total would be wrong.',
  '',
  'RATINGS: for circuit breakers extract rated current (amps), number of poles, and',
  'breaking capacity (kA) when stated.',
  '',
  'BUSBARS & NON-BREAKER ITEMS — do NOT turn a busbar or fabrication line into a',
  'circuit breaker. A line describing "Aluminium / Copper bus bars" — often written',
  '"Lot - 800A, 3 Phase and 400A neutral 415V, short circuit rated 50KA for 1sec, TPN',
  'Aluminium bus bars…" — is the panel BUSBAR system, not an MCCB/MCB: its amp and kA',
  'figures are the busbar current-carrying / short-circuit-withstand sizing, NOT a',
  'breaker rating. Emit it as its OWN line, requirement "…Aluminium busbar…", with',
  'isAccessory false and releaseType null and ratingAmp left null (it is not a breaker',
  'rating) — NEVER create an 800A / 300A MCCB from it. The same holds for other',
  'fabrication / material lines (the panel enclosure/CRCA sheet, gland plates, bus-bar',
  'insulators, PVC sleeves, cable, labels): capture each as its own item, never as a',
  'breaker. Downstream may leave these for review if the price list has no such row —',
  'that is correct; do not force them onto an unrelated breaker catalog.',
  '',
  'GLOBAL SPECS / NOTES: the BOQ often states requirements ONCE in a heading or a',
  'note that applies to EVERY item below it (e.g. "All MCCBs shall be adjustable',
  'with thermal settings (80%-100%), with overload and short-circuit releases, door',
  'interlock, front operating handle"). Read these carefully and APPLY them to each',
  'relevant line — do not ignore a requirement just because it is not repeated on',
  'every line.',
  '',
  'RELEASE TYPE: set releaseType for each breaker from the spec:',
  '  • "thermal-magnetic" — when it asks for adjustable thermal settings, a thermal',
  '    / thermal-magnetic / "TM" release, or thermal overload + magnetic short-circuit',
  '    releases (this is the common/default MCCB requirement).',
  '  • "microprocessor" — when it asks for a microprocessor / electronic / LSIG',
  '    release, or an "MTX"/electronic trip unit.',
  '  • null — when the document does not indicate a release type.',
  '  • CONDITIONAL BY RATING: a note may split the release type by a RATING THRESHOLD.',
  '    Read the threshold value AND its direction FROM the note, then classify EACH',
  '    breaker by comparing its OWN rated current to that threshold. The boundary words',
  '    are INCLUSIVE — a breaker whose rating EQUALS the threshold goes with the side',
  '    that names it:',
  '      – "X A and above" / "X A or higher" / "≥ X A"  → the threshold breaker (= X A)',
  '        AND every larger breaker belong to that clause. So "250A and above shall be',
  '        microprocessor" makes a 250A breaker MICROPROCESSOR (250 ≥ 250) and a 630A',
  '        microprocessor, while 200A / 125A / 100A / 63A (all below 250) are the other',
  '        type (thermal-magnetic).',
  '      – "X A and below" / "X A or lower" / "≤ X A"  → the threshold breaker (= X A)',
  '        AND every smaller breaker belong to that clause; larger ones get the other.',
  '    Apply it per breaker; never stamp one release on all breakers when the note',
  '    conditions it on rating, and never flip the direction. (The threshold and',
  '    direction are whatever THIS document states — read them exactly, do not assume.)',
  'Add the release words to keywords too (e.g. "thermal","magnetic","release").',
  '',
  'VARIANTS / COLOURS — some items are listed several times differing ONLY by a',
  'customer-chosen attribute the price list often does not give a separate catalog',
  'number for — most commonly the COLOUR of an indicator lamp / LED / pilot light /',
  'push button / selector (Red, Yellow, Blue, Green, Amber, White, Orange). Rules:',
  '  • Emit a SEPARATE line for EACH colour that appears as its own item — and capture',
  '    EVERY colour listed, NONE omitted. If the document lists Red, Yellow, Blue, Green',
  '    and Amber lamps, you MUST output all FIVE lines (Green and Amber included) — never',
  '    stop at Red/Yellow/Blue. Keep each line\'s own quantity (e.g. "2 Nos Red, 1 No',
  '    Yellow, 1 No Blue, 1 No Green, 1 No Amber" → five lines, quantity 2,1,1,1,1).',
  '  • Set the "variant" field to that colour in Title Case ("Red","Yellow","Blue",',
  '    "Green","Amber","White"); leave it null when the item has no such variant. Add the',
  '    colour word to keywords too.',
  '  • The compact token "RYB" / "RYBN" (e.g. "RYB indicating lamps") is a SEPARATE case:',
  '    it is shorthand for one lamp per letter — expand it into its own Red, Yellow, Blue',
  '    (RYBN adds a Neutral/White) lines with quantity = the stated Set/No count. This',
  '    expansion is ONLY for a literal "RYB"/"RYBN" token; it NEVER limits the colours',
  '    elsewhere — individually-named Green/Amber/etc. lamps are still emitted in full,',
  '    IN ADDITION to any RYB set. Do not collapse a list of individual colours into',
  '    "RYB", and never keep "RYB" itself as one line (no catalog exists for it).',
  'This applies to any product family, not just lamps: whenever the ONLY difference',
  'between repeated items is a named colour/variant, keep them as distinct lines and',
  'record the variant.',
  '',
  'KITS / SETS / COMPOSITE LINES — one BOQ line sometimes BUNDLES several distinct',
  'products, typically joined by "with" / "along with" / "including" / "&" (e.g. "RYB',
  'indicating lamps of LED module WITH 6A, 230V, 10kA, SP MCB", or "voltmeter with',
  'selector switch"). Split it into a SEPARATE line for EACH distinct product it names,',
  'so every component matches its own catalog:',
  '  • "RYB indicating lamps of LED module with 6A 230V 10kA SP MCB" → the three colour',
  '    lamp lines (Red/Yellow/Blue, from the rule above) PLUS one line for the "6A, 230V,',
  '    10kA, SP (single-pole) MCB". Carry each component\'s own ratings/voltage/poles',
  '    (SP = 1 pole) onto its line.',
  '  • Apply the line\'s Set/No count to each component (1 Set → quantity 1 for each).',
  '  • Do not leave a bundled line as one row — a single row naming two products cannot',
  '    match a catalog and gets mispriced.',
  '',
  'TECHNICAL ATTRIBUTES — capture EVERY specified value; never drop one. A price list',
  'often lists the SAME base product in many variants that differ only by a technical',
  'value (voltage, rating, class), each with its own catalog suffix and price, so the',
  'exact value the customer states is what selects the right one:',
  '  • Read and record every electrical value the line gives — VOLTAGE (V / VAC / VDC,',
  '    e.g. 240VAC, 415VAC, 230V, 110VDC, 24VDC), rated CURRENT (A), BREAKING capacity',
  '    (kA), POLES, FREQUENCY (Hz), RESISTANCE (Ω / ohm), power (W / VA / kW), ACCURACY',
  '    class (Cl 0.5 / 1.0 / 0.5S), IP rating, CT/PT ratio (e.g. 630/5A), cable/busbar',
  '    size (sq mm). Put EACH stated value WITH its unit into keywords (e.g. "240vac",',
  '    "50ka", "415v", "630/5a") and KEEP it verbatim in the requirement text.',
  '  • Fill the structured fields precisely: ratingAmp = rated current in amps;',
  '    breakingKa = the kA number; poles; releaseType; and voltage = the operating /',
  '    coil voltage string exactly as stated ("240VAC", "415VAC"). Set a field to null',
  '    ONLY when the line genuinely omits it — never invent or round a value.',
  '  • Because these values select the variant, two otherwise-identical lines that',
  '    differ only by such a value (e.g. an indicator lamp at 240VAC vs 415VAC, or a',
  '    meter Cl 0.5 vs Cl 1.0) are SEPARATE lines — do not collapse them to a generic',
  '    one, and do not carry one line\'s value onto another.',
  '',
  'TERMINOLOGY GLOSSARY — BOQs use trade shorthand; decode it before extracting so a',
  'terse spec still yields the right releaseType, poles and accessories:',
  '  • Microprocessor release (releaseType "microprocessor"): µP, uP, microprocessor,',
  '    electronic trip, LSI, LSIG, LSIG-N, "L-S-I-G" (these letters are the protection',
  '    functions Long-time/Short-time/Instantaneous/Ground — their presence implies an',
  '    electronic trip unit), MTX, ITrP (LK trade names), MicroLogic (Schneider), Ekip',
  '    (ABB), ETU (Siemens).',
  '  • Thermal-magnetic release (releaseType "thermal-magnetic"): TM, TMD, TMG, thermal',
  '    magnetic, adjustable thermal, thermal overload + magnetic short-circuit.',
  '  • Poles: TP / 3P = 3 poles; FP / 4P = 4 poles; TPN = 3 poles + neutral link (poles',
  '    3); FPN = 4 poles with rated neutral (poles 4); DP=2, SP=1.',
  '  • Construction: ACB = air circuit breaker (usually ≥630A, often drawout); MCCB =',
  '    moulded-case; MCB = miniature; MPCB/MPCB = motor protection breaker; DO/EDO =',
  '    drawout; FC/FX = fixed. Put the construction word in keywords.',
  '  • Rating letters (do NOT confuse): In = frame/rated current (use as ratingAmp);',
  '    Ir / Iset = adjustable overload setting; Icu = ultimate breaking capacity kA',
  '    (use as breakingKa); Ics = service breaking kA; Icw = short-time withstand kA.',
  '  • Accessory abbreviations → functional name: ST / SHT / shunt = shunt release;',
  '    UVT / UVR = under-voltage release; AX / OF / aux = auxiliary contact; SD / AL /',
  '    trip-alarm = alarm/trip-signal contact; RH / ROM = rotary handle (extended/door',
  '    = door-interlock handle, direct = internal); GF / earth fault / residual = ground-',
  '    fault protection; spreader / terminal links = spreader terminals.',
  '  • Meters: MFM / MDM / MFT = multifunction digital meter (measures V, A, PF, Hz, kW,',
  '    kWh); needs CT (current transformer) / PT; accuracy class 0.5S or 1.0; Modbus',
  '    RS485 = comms. A/V-meter = ammeter / voltmeter. Emit each as its own line.',
  'Use the glossary only to INTERPRET the spec; keep the breaker requirement text',
  'verbatim from the input, but set releaseType/poles/ratings/accessories accordingly.',
  '',
  'ACCESSORIES & ADD-ONS: breakers, switches and starters carry add-on devices.',
  'Emit EACH accessory the documents call for as its OWN line with isAccessory=true',
  'and parentLineNo = the lineNo of the device it belongs to (leave quantity 1 — the',
  'code derives it from the parent). Identify accessories by FUNCTION, which applies',
  'to any product type and any brand: operating / rotary handle and door-interlock',
  'mechanism; auxiliary / signalling / trip-alarm contact; shunt / under-voltage /',
  'trip release; terminal shrouds / spreader links; earth- / ground-fault protection;',
  'and similar. Rules that make this reliable and correctly counted:',
  '  1. ONE LINE PER BREAKER. Emit a SEPARATE accessory line for EACH breaker line',
  '     that needs it, with parentLineNo = THAT breaker line\'s lineNo. Never emit a',
  '     single accessory line meant to cover several breakers, and never put an',
  '     aggregate/summed count on an accessory. Always set the accessory quantity to',
  '     1: the code sets each accessory\'s count from its parent breaker and then',
  '     sums identical accessories across breakers, so per-breaker lines give the',
  '     correct total automatically. (If a panel has 4×250A and 9×200A breakers that',
  '     share one aux-contact catalog, emit an aux-contact line under the 250A line',
  '     and another under the 200A line — the code totals them to 13.)',
  '  2. GLOBAL notes count. When a heading or note says every device in a panel',
  '     needs an accessory (e.g. "…including door interlocking device, front',
  '     operating handle", "with earth fault protection"), emit that accessory under',
  '     EVERY breaker line beneath that note — do not skip it because it is stated',
  '     once in a note rather than repeated on each line.',
  '  3. ONE LINE PER FUNCTION, WORDED BY FUNCTION. For a given breaker, emit at most',
  '     one line per accessory function, and word its "requirement" as the STANDARD',
  '     accessory name — not the verbatim note phrase. Map the described accessory to',
  '     its functional name. A DOOR-INTERLOCK / FRONT / DOOR-MOUNTED operating handle',
  '     is the EXTENDED rotary handle (extended ROM) — NOT the internal Direct ROM: so',
  '     "door interlocking device / front operating handle" → requirement "Extended',
  '     rotary handle (door interlock)" with keywords ["extended","rotary","handle",',
  '     "door"]. (Use "Direct rotary handle" / ["direct","rotary","handle"] only when',
  '     the spec explicitly wants an internal/direct-mounted handle.) "overload +',
  '     short-circuit releases" is the breaker itself, not an accessory. A long',
  '     verbatim note phrase cannot be matched, so always use the short functional name.',
  '  4. Be consistent. For the same input, emit the SAME accessory set every time;',
  '     never itemise an accessory on one reading and drop it on another. Always emit',
  '     accessories as their own lines — never fold them into the breaker line text.',
  'Stay faithful: only emit accessories the documents actually ask for (explicitly or',
  'through a global note); do not invent ones the spec never mentions. Downstream',
  'matching keeps only the accessories the chosen brand offers and drops the rest, so',
  'when a required accessory is genuinely in scope, emit it. Give each accessory line',
  'specific lowercase keywords (e.g. ["auxiliary","contact"], ["shunt","release"],',
  '["spreader","terminal"], ["rotary","handle"], ["earth","fault"]).',
  '',
  'KEYWORDS: 3-8 lowercase keywords per line drawn from the product type so a',
  'catalogue search can find it. For breakers keep the requirement text verbatim from',
  'the input; for accessories use the short functional name (rule 3) as the',
  'requirement so it stays matchable and consolidates cleanly. If the additional',
  'instructions or brand rules require a particular product SERIES or frame (a code',
  'such as "DZ", "DN", "DU"), put that series code in lowercase into the keywords of',
  'every line it applies to — the catalogue search ranks rows carrying it first.',
].join('\n');

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
  const system = extraInstructions.trim()
    ? `${EXTRACT_SYSTEM}\n\nADDITIONAL INSTRUCTIONS (from the user's saved prompt — follow these too, and let them override the defaults above where they conflict):\n${extraInstructions.trim()}`
    : EXTRACT_SYSTEM;
  const user =
    `Preferred brand: ${ctx.brand}${ctx.category ? ` (primary product: ${ctx.category})` : ''}. ` +
    'Extract EVERY line item from the documents below — all product types, not just ' +
    'the primary product.\n\n' +
    // Compact cap: the BOQ (quantity source) is small and comes first, so it is
    // always included in full; this keeps token cost down while still covering the
    // BOQ + its notes and a good slice of the spec.
    `Input documents:\n${inputText.slice(0, 45000)}\n\n` +
    'Return a JSON object {"lines": Requirement[]} where each Requirement is ' +
    '{ "lineNo": number, "requirement": string, "quantity": number, ' +
    '"panelQty": number, "isAccessory": boolean, "parentLineNo": number|null, ' +
    '"ratingAmp": number|null, "poles": number|null, "breakingKa": number|null, ' +
    '"releaseType": string|null, "voltage": string|null, "variant": string|null, ' +
    '"board": string|null, "keywords": string[] }. ' +
    'board = the panel/board this item belongs to, exactly as the BOQ names it ' +
    '(e.g. "MV PANEL", "SUB MV PANEL", "Sub LT Panel 1"); apply the nearest panel ' +
    'heading above the item to every item under it, until the next panel heading. ' +
    'voltage is the operating/coil voltage exactly as stated ("240VAC", "415VAC", ' +
    '"230V", "24VDC") or null; capture every technical value (V/A/kA/Hz/Ω/class) into ' +
    'keywords too. ' +
    'variant is a distinguishing attribute like an indicator-lamp colour ("Red", ' +
    '"Yellow", …) when the item has one, else null — emit a separate line per colour. ' +
    'quantity is the per-panel count and panelQty is the number of identical panels ' +
    '(default 1); the code multiplies them. ' +
    'lineNo starts at 1. parentLineNo is null for breakers; for an accessory it is ' +
    "the lineNo of the breaker it belongs to.";
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
    voltage: l.voltage != null && String(l.voltage).trim() ? String(l.voltage).trim().slice(0, 40) : null,
    variant: l.variant != null && String(l.variant).trim() ? String(l.variant).trim().slice(0, 40) : null,
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
      const already = childrenSig.some((s) => def.keywords.every((k) => s.includes(k)));
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
        voltage: null,
        variant: null,
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
    /\bincom|i\/c\b/i.test(m.requirement) ||
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
        voltage: cv,
        variant: colour,
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
        voltage: null,
        variant: null,
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

export async function matchRequirements(
  provider: LlmProvider,
  requirements: Requirement[],
  candidates: Map<number, PriceListItem[]>,
  targetSeries: string[] = [],
  /** The quoted brands' trained keyword prompts (Brands page), or ''. */
  brandNotes = '',
): Promise<MatchDecision[]> {
  // Process in small batches so a big BOQ never exceeds the token-per-minute cap.
  const out: MatchDecision[] = [];
  for (let i = 0; i < requirements.length; i += MATCH_BATCH) {
    const batch = requirements.slice(i, i + MATCH_BATCH);
    out.push(...(await matchBatch(provider, batch, candidates, targetSeries, brandNotes)));
    if (i + MATCH_BATCH < requirements.length) await sleep(2500); // pace vs TPM
  }
  return out;
}

async function matchBatch(
  provider: LlmProvider,
  requirements: Requirement[],
  candidates: Map<number, PriceListItem[]>,
  targetSeries: string[],
  brandNotes: string,
): Promise<MatchDecision[]> {
  // Compact payload: only the fields the model needs to choose.
  const payload = requirements.map((r) => ({
    lineNo: r.lineNo,
    requirement: r.requirement,
    ratingAmp: r.ratingAmp,
    poles: r.poles,
    breakingKa: r.breakingKa,
    releaseType: r.releaseType,
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
    'You select the correct catalog number for each requirement line from its own',
    'candidate list. Rules:',
    '1. You MUST choose a catalogNo that appears in that line\'s candidates, or null.',
    '   Never invent a catalog number and never use another line\'s candidate.',
    '2. Only match when the candidate is the SAME KIND of product as the requirement',
    '   — an MCCB requirement must map to an MCCB, an auxiliary contact to an aux',
    '   contact, a shunt release to a shunt release, and so on. If the candidates are',
    '   a different type of product than the requirement, return null.',
    '   IMPORTANT: an MCB requirement (a "MCB", NOT an "MCCB") MUST map to an MCB',
    '   candidate (its description/family says "MCB" / "Miniature Circuit Breaker") —',
    '   do NOT return null just because same-rating MCCBs also appear in the list, and',
    '   never map an MCB to an MCCB or vice-versa. The same applies to RCCB, isolator,',
    '   changeover switch, contactor, relay and meter requirements: pick the candidate',
    '   of THAT product type when one is present.',
    '3. For breakers, match the rated current, poles and breaking capacity.',
    '   ALSO match the RELEASE TYPE and product series the requirement specifies:',
    '   - requirement.releaseType "thermal-magnetic" MUST map to a candidate whose',
    '     description says "Thermal-Magnetic Release" — NOT a "Microprocessor Release"',
    '     variant, even if the microprocessor one is cheaper or a closer rating.',
    '   - "microprocessor" maps only to a "Microprocessor Release" candidate.',
    '   - Stay within the same product SERIES/family the spec implies (e.g. an',
    '     adjustable "dsine" DN-series MCCB, not a basic DU/DY-series one that merely',
    '     shares the rating). Do NOT downgrade to a different series or release type',
    '     just because it is cheaper.',
    '   Only when release type AND series match equally should you then prefer the',
    '   lower-priced candidate. If no candidate has the required release type/series,',
    '   pick the closest correct-series one and lower confidence, or null.',
    '   BREAKING CAPACITY: a candidate with a HIGHER kA than required is acceptable',
    '   (a higher kA always satisfies the spec). Prefer the exact kA, but if the',
    '   required release-type/series only exists at a higher kA (e.g. a 125A adjustable',
    '   TM breaker is only available at 36kA when 25kA was asked), choose that higher-kA',
    '   part rather than returning null. Never go BELOW the required kA.',
    ...(targetSeries.length
      ? [
          `4. These items are for the ${targetSeries.join('/').toUpperCase()} product`,
          '   series. An accessory must be for that same series. If the only candidates',
          '   are for a different series (e.g. DZ, DN4, DU when the target is DN0-DN3),',
          '   return null rather than picking the wrong-series part.',
        ]
      : []),
    '5. Prefer null over a weak guess. Use confidence < 0.4 when unsure; a null match',
    '   should have confidence 0. It is correct and expected to return null for items',
    '   whose product line is not in the candidates (they will be flagged for review).',
    'Give a one-line reason for each decision.',
    ...(brandNotes.trim()
      ? [
          '',
          "BRAND NOTES (the user's saved keyword prompts for the quoted brand — use them to",
          'interpret the requirement and to choose between candidates; rule 1 still holds, so',
          'only ever pick a catalogNo from that line\'s candidates):',
          brandNotes.trim(),
        ]
      : []),
  ].join('\n');
  const user =
    `Lines with candidates:\n${JSON.stringify(payload)}\n\n` +
    'Return {"matches": [{ "lineNo": number, "catalogNo": string|null, ' +
    '"confidence": number, "reason": string }]}.';

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
    const wantAc = kw.includes('ac');
    const wantTac = kw.includes('tac');
    const wantExtended = kw.includes('extended');
    const wantPole = kw.find((k) => /^\d\s*pole$/.test(k))?.[0];
    const ok = (cd: string, frame: string): boolean =>
      accClass(cd) === cls &&
      cd.includes(frame) &&
      (!wantAc || /\bac\b/.test(cd)) &&
      (!wantTac || /\+\s*tac|\btac\b/.test(cd)) &&
      (!wantExtended || /extended/.test(cd)) &&
      (!wantPole || /\b(\d)\s*pole\b/.exec(cd)?.[1] === wantPole);
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
      description: withDetails(item?.description ?? null, [r.variant, r.voltage]),
      listPrice,
      discountPct,
      rate,
      amount,
      confidence,
      matchNote,
      priceListItemId: item?.id ?? null,
      variant: r.variant ?? null,
      voltage: r.voltage ?? null,
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
