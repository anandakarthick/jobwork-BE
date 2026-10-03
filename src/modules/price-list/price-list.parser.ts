/**
 * Generic switchgear price-list parser (validated against LK; brand-agnostic).
 *
 * Strategy:
 *  - Work off coordinate-reconstructed rows (see lib/pdf/extract-rows).
 *  - A price row contains one or more catalog numbers, each immediately
 *    followed (left-to-right) by its price. We pair `catalog -> next number`.
 *  - Poles come from the "3 Pole" / "4 Pole" column headers by x-position.
 *  - A range ("80-100") gives the rated current (its upper bound).
 *  - Breaking capacity (kA) is derived best-effort from the nearest Type label
 *    (…C = 25kA, …D = 36kA, …N = 50kA, …S = 70kA — an LK convention that is
 *    simply left null for brands that don't follow it).
 *
 * Nothing here is LK-specific enough to break on another brand's catalogue:
 * the catalog/price pairing, poles and rating extraction are structural, and
 * the kA-from-type step no-ops when the pattern doesn't match. Items priced
 * "* Price on request" (no number) are skipped.
 */
import type { Page, Row, Word } from '../../lib/pdf/extract-rows';

/** A catalog line ready to become a PriceListItem row. */
export interface ParsedItem {
  catalogNo: string;
  listPrice: number;
  poles: number | null;
  ratingAmp: number | null;
  ratingAmpMin: number | null;
  ratingAmpMax: number | null;
  breakingKa: number | null;
  family: string | null;
  type: string | null;
  /** Release type for breakers (Thermal-Magnetic / Microprocessor / …), or null. */
  release?: string | null;
  description: string;
  /** Pricing unit, when the source states one (AI ingest). */
  unit?: string | null;
  pageNo: number | null;
  rawText: string | null;
  attributes: Record<string, unknown> | null;
}

/**
 * A catalog number: 2–4 upper-case letters, then a digit, then at least four
 * more letters/digits, with three or more digits in total — CM91712OOKOOG,
 * ST27745OOOO, DZ4F0250NXD1AOOOO, UW108NXD01800, AUF3C200601, BB40E50C,
 * LTFR0701B2. (Plain words and short spec tokens like "IP20" or "RS485" fail
 * the length or digit-count test; a row is only taken when a price follows.)
 */
const CATALOG_SHAPE = /^[A-Z]{2,4}\d[A-Z0-9]{4,}$/;
const CATALOG = {
  test: (s: string): boolean => CATALOG_SHAPE.test(s) && (s.match(/\d/g)?.length ?? 0) >= 3,
};
const PRICE = /^\d{2,7}$/; // bare integer price (>=2 digits excludes pkg qty "1")
const RANGE = /^(\d+)-(\d+)$/; // thermal release range e.g. 80-100
const TYPE = /^D[NUYZ]\d[A-Z0-9/*\-]*$/; // DN0-100C, DN2-250D, DZ4-250N, DU/DN...
const SECTION_CODE = /^\[\d{3,4}\]$/; // group code that trails a section heading, e.g. [8538]

/** Column split for two-column accessory pages (A4 points; page width ~595). */
const COLUMN_X = 310;

/** Trailing-letter -> breaking capacity (kA), per the LK "Breaking Capacity" note
 *  on each page (DN pages: C/D/N/S; DZ pages add H = 80kA). */
const KA_BY_SUFFIX: Record<string, number> = { C: 25, D: 36, N: 50, S: 70, H: 80 };

function toNum(s: string): number {
  return Number(s.replace(/[^0-9.]/g, ''));
}

/** Locate "N Pole" column headers and return their x-centres. */
function findPoleColumns(rows: Row[]): { x: number; poles: number }[] {
  const cols: { x: number; poles: number }[] = [];
  const add = (x: number, poles: number) => {
    if (!cols.some((c) => c.poles === poles)) cols.push({ x, poles });
  };
  for (const row of rows) {
    for (let i = 0; i < row.words.length; i++) {
      const w = row.words[i]!;
      // Combined token e.g. "3 Pole" / "4 Pole".
      const combined = /^([34])\s*Pole$/i.exec(w.str);
      if (combined) {
        add(w.x, Number(combined[1]));
        continue;
      }
      // Split tokens: "3" | "Pole".
      if (/^Pole$/i.test(w.str)) {
        const prev = row.words[i - 1];
        if (prev && (prev.str === '3' || prev.str === '4')) add(prev.x, Number(prev.str));
      }
    }
  }
  return cols;
}

/** Collect Type labels (with their vertical position) for nearest-match. */
function findTypeLabels(rows: Row[]): { top: number; str: string }[] {
  const labels: { top: number; str: string }[] = [];
  for (const row of rows) {
    for (const w of row.words) {
      // A DZ-style catalog number (DZ0T0016…) also fits the TYPE shape — skip those.
      if (TYPE.test(w.str) && !CATALOG.test(w.str)) labels.push({ top: row.top, str: w.str });
    }
  }
  return labels;
}

/** The frame's max rating encoded in a Type name, e.g. "DN2-250D" → 250. */
function typeFrameRating(type: string): number | null {
  const m = /(\d{2,4})/.exec(type); // first 2–4 digit run (skips the series digit)
  return m ? Number(m[1]) : null;
}

/**
 * Assign the Type label for a rating row. The Type column is a MERGED cell
 * spanning several range-rows, so its label sits at the group's vertical
 * centre — nearest-vertical alone mislabels a group's last row with the NEXT
 * group's Type (e.g. 200-250A under DN2-250D getting tagged DN3B-400D).
 *
 * Primary rule: a frame covers ratings up to the number in its name
 * (DN2-250D → ≤250, DN3B-400D → ≤400), so pick the frame with the SMALLEST
 * encoded rating that still ≥ the row's max rating (tightest fit); ties break
 * by vertical nearness. Falls back to nearest-vertical when names carry no
 * rating (keeps behaviour for other catalogues).
 *
 * When the catalog number itself starts with a series stem that some labels
 * share (DZ4T0160… → "DZ4-250N"), only those labels are considered: the DZ
 * tables list several frames at the same rating (160A exists in DZ1, DZ2 and
 * DZ4), and the tightest-rating rule alone would pick a neighbouring frame.
 */
function assignType(
  allLabels: { top: number; str: string }[],
  rowTop: number,
  ratingMax: number | null,
  catalogNo = '',
): string | null {
  const stem = /^([A-Z]{2}\d)/.exec(catalogNo.toUpperCase())?.[1];
  const sameSeries = stem ? allLabels.filter((t) => t.str.toUpperCase().startsWith(stem)) : [];
  const typeLabels = sameSeries.length ? sameSeries : allLabels;
  if (ratingMax != null) {
    let best: { top: number; str: string; rating: number } | null = null;
    for (const t of typeLabels) {
      const r = typeFrameRating(t.str);
      if (r == null || r < ratingMax) continue;
      if (
        !best ||
        r < best.rating ||
        (r === best.rating && Math.abs(t.top - rowTop) < Math.abs(best.top - rowTop))
      ) {
        best = { top: t.top, str: t.str, rating: r };
      }
    }
    if (best) return best.str;
  }
  // Fallback: nearest label vertically (within a sane band).
  let nb = typeLabels[0]!;
  for (const t of typeLabels) if (Math.abs(t.top - rowTop) < Math.abs(nb.top - rowTop)) nb = t;
  return Math.abs(nb.top - rowTop) <= 60 ? nb.str : null;
}

/** Lines that are notes/footers, never a product family. */
const NOISE_HEADING = /^\s*(note|general information|special applications|\*|�|#)/i;

/** A short family label for the page, from its section heading if present. */
function findFamily(rows: Row[]): string | null {
  const kw = /(MCCB|ACB|Capacitor|Contactor|Relay|Meter|Isolator|Changeover|RCCB|MCB|Lamp|Transformer)/i;
  const clean = (r: Row) => r.text.replace(/\[\d+\]/g, '').replace(/\s+/g, ' ').trim().slice(0, 150);
  // A page-title heading is short and not a highlight bullet / spec sentence.
  const usable = (r: Row) =>
    !NOISE_HEADING.test(r.text) && !/^[›»•]/.test(r.text.trim()) && r.text.trim().length <= 60;
  // Prefer the TOPMOST product-title heading (rows are already top-to-bottom).
  // Using a sub-range heading (e.g. "BIS-Certified HR MCBs Range - 80-125A") would
  // mislabel the whole page, so the main title ("Miniature Circuit Breaker (MCB)")
  // — which sits first — must win.
  const title = rows.find((r) => usable(r) && kw.test(r.text));
  return title ? clean(title) : null;
}

/**
 * For non-rating rows (accessories, relays, …) build a readable description
 * from the row text by removing the catalog number, its price, and packaging
 * tokens — leaving the human descriptor (e.g. "1 C/O + 1C/O - Right").
 */
function cleanRowDescription(rawText: string, catalogNo: string, priceStr: string): string {
  let s = rawText;
  // Drop every catalog-looking token and bare price/pkg numbers.
  s = s
    .split(/\s+/)
    .filter((t) => t !== catalogNo && !CATALOG.test(t) && t !== priceStr)
    .filter((t) => !/^\d{1,3}$/.test(t)) // stray pkg counts
    .join(' ');
  s = s.replace(/\bSet of\b/gi, '').replace(/\s+/g, ' ').trim();
  return s.slice(0, 200);
}

/**
 * Two-column accessory pages reconstruct a left-column item and an unrelated
 * right-column item onto the SAME visual row, so the plain row text mixes both
 * (e.g. an Auxiliary Contact row bleeding "DN0 Direct ROM" from the Rotary
 * Handle column beside it). Build the descriptor from only the words that sit
 * in the catalog's own column and to its left — the descriptor always precedes
 * its catalog number — dropping catalog/price/section-code tokens.
 */
function columnDescription(words: Word[], catalogX: number, priceStr: string): string {
  const left = catalogX < COLUMN_X;
  const parts = words
    .filter(
      (w) =>
        (left ? w.x < COLUMN_X : w.x >= COLUMN_X) &&
        w.x < catalogX &&
        !CATALOG.test(w.str) &&
        !SECTION_CODE.test(w.str) &&
        w.str !== priceStr,
    )
    .map((w) => w.str);
  return parts.join(' ').replace(/\s+/g, ' ').trim().slice(0, 200);
}

function polesForX(x: number, cols: { x: number; poles: number }[]): number | null {
  if (cols.length === 0) return null;
  let best = cols[0]!;
  for (const c of cols) if (Math.abs(c.x - x) < Math.abs(best.x - x)) best = c;
  return best.poles;
}

function kaFromType(type: string | null): number | null {
  if (!type) return null;
  const letters = type.replace(/[^A-Z]/g, '');
  const last = letters.at(-1);
  return last && last in KA_BY_SUFFIX ? KA_BY_SUFFIX[last]! : null;
}

/**
 * Normalise a raw price-list section heading into a clean product-type label
 * ("DN MCCB Range [8538]" → "MCCB", "Advanced Multifunction Meters" → "Meter").
 * Used for the quote's Family column and description so it reads like the sample.
 */
export function cleanFamily(family: string | null, type: string | null): string | null {
  const s = `${family ?? ''} ${type ?? ''}`;
  if (/accessor/i.test(s)) return /\bMCB\b/i.test(s) && !/MCCB/i.test(s) ? 'MCB Accessories' : 'MCCB Accessories';
  if (/\bMCCB\b/i.test(s)) return 'MCCB';
  if (/\bACB\b|Air Circuit Breaker/i.test(s)) return 'ACB';
  if (/RCCB|RCBO|Residual/i.test(s)) return 'RCCB';
  if (/\bMCB\b|Miniature Circuit Breaker/i.test(s)) return 'MCB';
  if (/Changeover/i.test(s)) return 'Changeover Switch';
  if (/Isolator/i.test(s)) return 'Isolator';
  if (/Capacitor Duty/i.test(s)) return 'Capacitor Duty Contactor';
  if (/Contactor/i.test(s)) return 'Contactor';
  if (/Overload Relay/i.test(s)) return 'Overload Relay';
  if (/Relay/i.test(s)) return 'Relay';
  if (/Meter/i.test(s)) return 'Meter';
  if (/Soft\s*Starter/i.test(s)) return 'Soft Starter';
  if (/\bDrive\b|VFD/i.test(s)) return 'AC Drive';
  if (/Capacitor/i.test(s)) return 'Capacitor';
  return family ? family.replace(/\[\d+\]/g, '').replace(/\s+/g, ' ').trim().slice(0, 60) : null;
}

function buildDescription(item: {
  ratingAmpMax: number | null;
  poles: number | null;
  breakingKa: number | null;
  release: string | null;
  type: string | null;
  family: string | null;
}): string {
  const parts: string[] = [];
  if (item.ratingAmpMax != null) parts.push(`${item.ratingAmpMax}A`);
  if (item.poles != null) parts.push(`${item.poles}P`);
  if (item.breakingKa != null) parts.push(`${item.breakingKa}kA`);
  if (item.release) parts.push(item.release);
  if (item.type) parts.push(item.type);
  // Append the CLEAN product type (e.g. "MCCB"), not the raw "… Range" heading.
  const fam = cleanFamily(item.family, item.type);
  if (fam) parts.push(fam);
  return parts.join(', ');
}

/**
 * Normalise an MCCB/ACB section heading into a release-type label, or null.
 * A heading that names the release MODEL ("DZ MCCB with Microprocessor Release
 * iTRP3", "DN MCCB with Microprocessor Release MTX2.0") keeps that model, exactly
 * as the price list prints it — the catalogue lists iTRP1 and iTRP3 rows on
 * different pages with otherwise identical descriptions, and the model is the
 * only thing telling them apart. What each model protects (LSI / LSIG) is left to
 * the brand rules and reference text, not hard-coded here.
 */
function releaseFromHeading(text: string): string | null {
  if (/micro\s*processor/i.test(text)) {
    const models = [...text.matchAll(/\b(iTRP\s*\d|MTX\s*\d(?:\.\d)?)\b/gi)].map((m) =>
      m[1]!.replace(/\s+/g, '').replace(/^itrp/i, 'iTRP').replace(/^mtx/i, 'MTX'),
    );
    return models.length ? `Microprocessor Release ${models.join(' & ')}` : 'Microprocessor Release';
  }
  if (/motor\s+protection/i.test(text)) return 'Motor Protection Release';
  if (/thermal\s*-?\s*magnetic\s+release/i.test(text)) return 'Thermal-Magnetic Release';
  return null;
}
/** A bare "... MCCB/MCB/ACB Range" heading that opens a new (non-release) section. */
const RANGE_HEADING = /\b(MCCB|MCB|ACB)\s+Range\b/i;

/** A standalone rated-current token, e.g. "63A", "6A", "0.5A" (single-rating rows). */
const AMP_TOKEN = /^(\d+(?:\.\d+)?)A$/i;

/**
 * Pole count from a pole-group heading used by single-rating tables (MCB, RCCB…):
 * "Single Pole (SP)" → 1, "Two/Double Pole (DP)" → 2, "Three/Triple Pole (TP)" → 3,
 * "Triple Pole + Neutral (TPN)" / "Four Pole (FP)" → 4. Returns null if not a heading.
 */
function polesFromPoleHeading(text: string): number | null {
  const t = text.trim();
  if (t.length > 34) return null; // real headings are short; skip long note lines
  if (/\bfour\s+pole\b|\(FP\)/i.test(t)) return 4;
  if (/triple\s+pole\s*\+?\s*neutral|\(TPN\)/i.test(t)) return 4;
  if (/\b(three|triple)\s+pole\b|\(TP\)/i.test(t)) return 3;
  if (/\b(two|double)\s+pole\b|\(DP\)/i.test(t)) return 2;
  if (/\bsingle\s+pole\b|\(SP\)/i.test(t)) return 1;
  return null;
}

/**
 * Rows this parser cannot represent: a catalog number followed by several bare
 * prices (a price per variant column — colour, voltage, mounting…). The parser
 * keeps only the first price, so a list dominated by such rows is better read
 * by the AI, which expands every column. Counted so the ingest flow can decide.
 */
const MATRIX_PRICES = 3;
export function countMatrixRows(pages: Page[]): number {
  let n = 0;
  for (const page of pages) {
    for (const row of page.rows) {
      const words = row.words.map((w) => w.str);
      for (let i = 0; i < words.length; i++) {
        if (!CATALOG.test(words[i]!)) continue;
        let prices = 0;
        for (let j = i + 1; j < words.length && !CATALOG.test(words[j]!); j++) {
          if (PRICE.test(words[j]!)) prices++;
        }
        if (prices >= MATRIX_PRICES) n++;
      }
    }
  }
  return n;
}

/** Parse every priced catalog line out of the reconstructed pages. */
export function parsePriceList(pages: Page[]): ParsedItem[] {
  const items: ParsedItem[] = [];

  // Release type is set by a "… with <Thermal-Magnetic|Microprocessor> Release"
  // heading and persists (across pages) until the next such heading or a new
  // "… MCCB Range" section heading resets it. It's the signal that lets the
  // matcher tell an adjustable dsine TM breaker from a microprocessor or a
  // basic (DU/DY) one that shares the same rating/poles/kA.
  let currentRelease: string | null = null;
  // Pole count for single-rating tables (MCB/RCCB), set by a "Single/Four Pole"
  // heading; reset on a new "… Range" section so it doesn't leak across products.
  let currentPoles: number | null = null;
  // The "[code]" of the current "… Range" section. A catalogue repeats the same
  // range heading at the top of every page of a section (e.g. "DZ MCCB Range
  // [8536]" on pages 48–58), so only a heading with a DIFFERENT code starts a
  // new section — otherwise the release type set on the first page would be
  // lost on the pages that follow.
  let currentSection: string | null = null;

  for (const page of pages) {
    const poleCols = findPoleColumns(page.rows);
    const typeLabels = findTypeLabels(page.rows);
    const family = findFamily(page.rows);

    // Section headings (e.g. "Shunt Release [8538]") sit above their rows in a
    // two-column layout; the rows themselves don't repeat the heading. Track the
    // current heading per column as we descend so accessory descriptions can be
    // prefixed with what they actually are — which is what makes them findable.
    let headingLeft: string | null = null;
    let headingRight: string | null = null;

    for (const row of page.rows) {
      const words = row.words;

      const rowHasCatalog = words.some((w) => CATALOG.test(w.str));

      // Detect section headings: a "[code]" token whose preceding same-column
      // words form the heading name. This runs on EVERY row (not only catalog-
      // free ones): on two-column accessory pages a left-column heading is
      // reconstructed onto the same visual row as the OTHER column's data row,
      // so gating on "no catalog" would silently drop headings like "Trip Alarm
      // Contact" and leak the previous section's heading onto those items.
      for (let k = 0; k < words.length; k++) {
        // A section code can arrive either as its own "[8538]" token or fused
        // onto the heading text ("Auxiliary Contact [8538]") depending on how
        // pdfjs split the run — accept both, and take any inline name with it.
        const fused = /^(.*?)\s*\[\d{3,4}\]$/.exec(words[k]!.str);
        if (!fused) continue;
        const codeX = words[k]!.x;
        const inlineName = fused[1]!.trim();
        const prior = words
          .slice(0, k)
          .filter((w) => w.x < codeX + 5 && (codeX < COLUMN_X ? w.x < COLUMN_X : w.x >= COLUMN_X))
          .filter((w) => !/^\d+$/.test(w.str) && !/^\[\d{3,4}\]$/.test(w.str))
          .slice(-6)
          .map((w) => w.str);
        const name = [...prior, inlineName].join(' ').replace(/\s+/g, ' ').trim();
        if (name.length >= 3) {
          if (codeX < COLUMN_X) headingLeft = name;
          else headingRight = name;
        }
      }

      if (!rowHasCatalog) {
        // Track the current release-type section (persists until reset).
        const rel = releaseFromHeading(row.text);
        if (rel) currentRelease = rel;
        else if (RANGE_HEADING.test(row.text)) {
          const code = /\[(\d{3,4})\]/.exec(row.text)?.[1] ?? null;
          if (code == null || code !== currentSection) {
            currentRelease = null;
            currentPoles = null; // new product section — forget the pole group
          }
          currentSection = code;
        }
        // Track the current pole group for single-rating tables (MCB/RCCB).
        const ph = polesFromPoleHeading(row.text);
        if (ph != null) currentPoles = ph;
      }

      const rangeWord = words.find((w) => RANGE.test(w.str));
      const hasRange = rangeWord != null;
      let ratingMin: number | null = null;
      let ratingMax: number | null = null;
      if (rangeWord) {
        const m = RANGE.exec(rangeWord.str)!;
        ratingMin = Number(m[1]);
        ratingMax = Number(m[2]);
      } else {
        // Single-rating row (MCB/RCCB/etc.): a lone "63A"/"6A"/"0.5A" token.
        const ampWord = words.find((w) => AMP_TOKEN.test(w.str));
        if (ampWord) {
          ratingMax = Number(AMP_TOKEN.exec(ampWord.str)![1]);
          ratingMin = ratingMax;
        }
      }
      const isRated = ratingMax != null; // rating from a range OR a single value

      for (let i = 0; i < words.length; i++) {
        const w = words[i]!;
        if (!CATALOG.test(w.str)) continue;

        // Price = first bare number after this catalog, before the next catalog.
        let priceStr: string | null = null;
        for (let j = i + 1; j < words.length; j++) {
          const s = words[j]!.str;
          if (CATALOG.test(s)) break;
          if (PRICE.test(s)) {
            priceStr = s;
            break;
          }
        }
        if (!priceStr) continue; // "* Price on request" — skip

        // MCCB rating-table attributes (poles / type / kA) are only meaningful
        // on rows that carry a thermal range. Accessory rows have no range, so
        // we leave those null and describe them by their raw row text — the
        // nearest-label heuristic otherwise mis-attaches MCCB context to them.
        // Range rows (MCCB) get poles from the pole COLUMNS; single-rating rows
        // (MCB/RCCB) get poles from the current pole-group heading.
        const poles = hasRange
          ? polesForX(w.x, poleCols)
          : isRated
            ? currentPoles
            : null;
        const type =
          hasRange && typeLabels.length ? assignType(typeLabels, row.top, ratingMax, w.str) : null;
        const breakingKa = kaFromType(type);

        // Release type applies to range breaker rows (MCCBs), not single-rating/accessory rows.
        const release = hasRange ? currentRelease : null;
        const parsed = {
          ratingAmp: ratingMax,
          ratingAmpMin: ratingMin,
          ratingAmpMax: ratingMax,
          poles,
          breakingKa,
          release,
          type,
          family,
        };

        const rawText = row.text.slice(0, 500);
        // Prefix accessory rows with their section heading (by column) so the
        // description carries what the item IS (e.g. "Shunt Release …"), and
        // build the descriptor from same-column words only so the neighbouring
        // column's text (a different accessory) doesn't bleed in.
        const heading = w.x < COLUMN_X ? headingLeft : headingRight;
        const colDesc =
          columnDescription(words, w.x, priceStr) ||
          cleanRowDescription(rawText, w.str, priceStr);
        const accessoryDesc = [heading, colDesc].filter(Boolean).join(' — ');
        items.push({
          catalogNo: w.str,
          listPrice: toNum(priceStr),
          ...parsed,
          // Rated rows (range or single) with a known pole count get a clean
          // synthetic description; other rows (accessories) get heading + row text.
          description:
            isRated && poles != null ? buildDescription(parsed) || accessoryDesc : accessoryDesc,
          pageNo: page.pageNo,
          rawText,
          attributes: { x: Math.round(w.x), priceRaw: priceStr, hasRange, isRated, heading, release },
        });
      }
    }
  }

  return dedupeByCatalog(items);
}

/** A description that names a specific accessory type (vs a generic page family). */
const ACCESSORY_IDENTITY =
  /^(Auxiliary Contact|Trip Alarm|Auxiliary 1 C\/O|Shunt Release|Under Voltage|Rotary Handle|Extended ROM|Direct ROM|Spreader|External Neutral|Adaptor kit|MIL Kit|Key lock|Terminal|Phase Barrier)/i;

/** A frame/series token (DN0, DU125, DZ3 …) — the detail that makes an accessory row usable. */
const FRAME_TOKEN = /\bD[NUZY]\d/i;

/**
 * Collapse repeated catalog numbers (the same SKU can appear in a summary row
 * and its detail row, one carrying rating/poles and the other not). Keep the
 * most informative representative: prefer a row with a rating, then more poles
 * info, then — for accessories reused across frame pages (DN/DU) — the one whose
 * description names its FRAME (e.g. "… DN0 Extended ROM" over a bare
 * "Extended ROM") and a specific accessory type, then the longer raw text.
 */
function dedupeByCatalog(items: ParsedItem[]): ParsedItem[] {
  const best = new Map<string, ParsedItem>();
  const score = (it: ParsedItem) => {
    const d = it.description ?? '';
    // A contact-type accessory (aux / trip-alarm contact) is never a multi-pole
    // "Set of N" item — such a row is a mis-paired description (a spreader/handle
    // catalog cross-associated with a contact heading), so deprioritise it.
    const misPaired = /^(Auxiliary Contact|Trip Alarm)/i.test(d) && /\bpole\b|\bset of\b/i.test(d);
    return (
      (it.ratingAmpMax != null ? 4 : 0) +
      (it.poles != null ? 2 : 0) +
      (ACCESSORY_IDENTITY.test(d) ? 1.5 : 0) +
      (FRAME_TOKEN.test(d) ? 2 : 0) +
      (misPaired ? -4 : 0) +
      Math.min(1, (it.rawText?.length ?? 0) / 500)
    );
  };
  for (const it of items) {
    const key = it.catalogNo.trim().toUpperCase();
    const cur = best.get(key);
    if (!cur || score(it) > score(cur)) best.set(key, it);
  }
  // Preserve first-seen order for stable output.
  const seen = new Set<string>();
  const out: ParsedItem[] = [];
  for (const it of items) {
    const key = it.catalogNo.trim().toUpperCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(best.get(key)!);
  }
  return out;
}
