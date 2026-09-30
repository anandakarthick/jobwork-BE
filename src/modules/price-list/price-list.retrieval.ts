/**
 * Candidate retrieval for quote matching.
 *
 * Given a single requirement (rating / poles / kA and/or free-text keywords),
 * pull a SMALL, ranked set of price-list rows from the DB. This is the "R" in
 * RAG: at quote time we send the model only these candidates, never the whole
 * price list. Retrieval favours recall — the model makes the final pick.
 *
 * Two signals combine into one score:
 *   - Rating-based (MCCBs): rated current, poles, breaking capacity.
 *   - Keyword-based (accessories & free text): matches against catalog / type /
 *     family / description / raw row text.
 */
import type { PriceListItem } from '@prisma/client';
import { prisma } from '../../lib/prisma';
import { HttpError } from '../../lib/http-error';

export interface RequirementQuery {
  /** Scope: a specific price-list document, OR a category (+ optional brand). */
  documentId?: number;
  categoryId?: number;
  brand?: string;

  poles?: number | null;
  ratingAmp?: number | null;
  breakingKa?: number | null;
  keywords?: string[];
  /** Operating/coil voltage (e.g. "240VAC") — selects the right variant of a
   *  product listed at many voltages (indicator lamps, coils, etc.). */
  voltage?: string | null;

  /** Max candidates to return (default 12). */
  limit?: number;
}

export interface Candidate {
  item: PriceListItem;
  score: number;
  reasons: string[];
}

function num(d: PriceListItem['listPrice'] | null): number | null {
  return d == null ? null : Number(d);
}

/** Load the scoped price-list rows once; reuse across many requirement lines. */
export async function loadPool(scope: {
  documentId?: number;
  categoryId?: number;
  brand?: string;
}): Promise<PriceListItem[]> {
  if (!scope.documentId && !scope.categoryId)
    throw HttpError.badRequest('Retrieval scope needs documentId or categoryId');
  return prisma.priceListItem.findMany({
    where: {
      ...(scope.documentId ? { documentId: scope.documentId } : {}),
      ...(scope.categoryId ? { categoryId: scope.categoryId } : {}),
      ...(scope.brand ? { brand: scope.brand } : {}),
    },
  });
}

/**
 * Collapse duplicate catalog numbers (the same accessory is listed on several
 * pages). Keep the most informative representative: prefer a real rating row,
 * then the longest raw text.
 */
function dedupeByCatalog(items: PriceListItem[]): PriceListItem[] {
  const best = new Map<string, PriceListItem>();
  for (const it of items) {
    const cur = best.get(it.catalogNo);
    if (!cur) {
      best.set(it.catalogNo, it);
      continue;
    }
    const itHasRange = it.ratingAmp != null;
    const curHasRange = cur.ratingAmp != null;
    if (itHasRange && !curHasRange) best.set(it.catalogNo, it);
    else if (itHasRange === curHasRange && (it.rawText?.length ?? 0) > (cur.rawText?.length ?? 0))
      best.set(it.catalogNo, it);
  }
  return [...best.values()];
}

/** Score one item against a requirement. Higher = better. */
export function scoreItem(item: PriceListItem, q: RequirementQuery): { score: number; reasons: string[] } {
  let score = 0;
  const reasons: string[] = [];

  const hay = `${item.catalogNo} ${item.type ?? ''} ${item.family ?? ''} ${item.description} ${
    item.rawText ?? ''
  }`.toLowerCase();

  // Voltage discriminator — decisive for products listed at many voltages (a lamp
  // at "240VAC" must pick the 240V variant, not the first 12V one). Compared
  // whitespace-insensitively so "240vac" matches a row that writes "240 VAC".
  if (q.voltage) {
    const nv = q.voltage.toLowerCase().replace(/\s+/g, '');
    if (nv && hay.replace(/\s+/g, '').includes(nv)) {
      score += 60;
      reasons.push(`voltage ${q.voltage}`);
    }
  }

  if (q.ratingAmp != null) {
    const max = num(item.ratingAmpMax);
    const min = num(item.ratingAmpMin);
    if (max != null) {
      const diff = Math.abs(max - q.ratingAmp);
      if (diff === 0) {
        score += 100;
        reasons.push('exact rating');
      } else if (min != null && q.ratingAmp >= min && q.ratingAmp <= max) {
        score += 90;
        reasons.push('rating in range');
      } else {
        score += Math.max(0, 80 - diff);
        if (diff <= 25) reasons.push(`~${max}A`);
      }
    } else {
      // Rating-based line, but this row has no rating (e.g. an accessory).
      score -= 40;
    }
  }

  if (q.poles != null && item.poles != null) {
    if (item.poles === q.poles) {
      score += 50;
      reasons.push(`${q.poles}P`);
    } else {
      score -= 40;
    }
  }

  if (q.breakingKa != null && item.breakingKa != null) {
    const ik = Number(item.breakingKa);
    if (ik === q.breakingKa) {
      score += 40;
      reasons.push(`${q.breakingKa}kA`);
    } else if (ik > q.breakingKa) {
      score += 15;
      reasons.push(`${ik}kA≥req`);
    } else {
      score -= 40;
    }
  }

  if (q.keywords?.length) {
    let hits = 0;
    for (const kw of q.keywords) {
      const k = kw.trim().toLowerCase();
      if (k && hay.includes(k)) hits++;
    }
    if (hits) {
      score += hits * 20;
      reasons.push(`${hits} keyword${hits > 1 ? 's' : ''}`);
    }

    // Variant discriminator: "extended" vs "direct" (door-mounted vs internal
    // rotary handle / ROM) are mutually exclusive product variants. When the
    // requirement names one, a row that is clearly the OTHER is the wrong pick —
    // penalise it hard so the correct variant wins even when its own row text is
    // terse. Generic electrical terminology, not tied to any brand.
    const kw = q.keywords.map((k) => k.trim().toLowerCase());
    if (kw.includes('extended') && /\bdirect\b/.test(hay) && !/\bextended\b/.test(hay)) {
      score -= 60;
      reasons.push('wrong variant (direct)');
    }
    if (kw.includes('direct') && /\bextended\b/.test(hay) && !/\bdirect\b/.test(hay)) {
      score -= 60;
      reasons.push('wrong variant (extended)');
    }
    // AC/DC coil discriminator (e.g. a shunt/UV release asked for AC must not
    // match the 24V-DC variant). Same generic idea as direct/extended.
    if (kw.includes('ac') && /\bdc\b/.test(hay) && !/\bac\b/.test(hay)) {
      score -= 50;
      reasons.push('wrong coil (dc)');
    }
    // Pole-count discriminator: an accessory asked for "4 pole" must not match a
    // "3 pole" variant (spreader terminals come in both). Generic.
    const poleKw = kw.find((k) => /^\d\s*pole$/.test(k));
    if (poleKw) {
      const want = poleKw[0];
      const m = /\b(\d)\s*pole\b/.exec(hay);
      if (m && m[1] !== want) {
        score -= 40;
        reasons.push('wrong poles');
      }
    }
  }

  return { score, reasons };
}

/** Rank a preloaded pool against one requirement and return the top candidates. */
export function rankCandidates(
  pool: PriceListItem[],
  q: RequirementQuery,
): Candidate[] {
  const limit = q.limit ?? 12;
  const scored: Candidate[] = [];
  for (const item of dedupeByCatalog(pool)) {
    const { score, reasons } = scoreItem(item, q);
    if (score > 0) scored.push({ item, score, reasons });
  }
  // Ranking: score first; then, among equally-good matches (e.g. two 630A/4P/50kA
  // breakers that differ only by release type), prefer the lower-priced base
  // variant — a generic requirement should default to the standard option, not
  // a premium one. Catalog number is the final, deterministic tie-break.
  scored.sort(
    (a, b) =>
      b.score - a.score ||
      Number(a.item.listPrice) - Number(b.item.listPrice) ||
      a.item.catalogNo.localeCompare(b.item.catalogNo),
  );
  return scored.slice(0, limit);
}

/** Convenience: load the scoped pool and rank in one call (used for testing). */
export async function findCandidates(q: RequirementQuery): Promise<Candidate[]> {
  const pool = await loadPool({
    documentId: q.documentId,
    categoryId: q.categoryId,
    brand: q.brand,
  });
  return rankCandidates(pool, q);
}
