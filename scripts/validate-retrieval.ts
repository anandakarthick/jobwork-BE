/**
 * Validates candidate retrieval against the Project 2 sample: each requirement
 * (from the real output quote) should surface its exact catalog number as the
 * top-ranked candidate. Run: npx tsx scripts/validate-retrieval.ts
 */
import { prisma } from '../src/lib/prisma';
import { loadPool, rankCandidates, type RequirementQuery } from '../src/modules/price-list/price-list.retrieval';

interface Case {
  label: string;
  expected: string;
  q: Omit<RequirementQuery, 'documentId'>;
}

// Straight from the sample output xlsx.
const CASES: Case[] = [
  { label: '100A 4P 25kA MCCB', expected: 'CM91712OOKOOG', q: { ratingAmp: 100, poles: 4, breakingKa: 25 } },
  { label: '63A 4P 25kA MCCB', expected: 'CM91712OOHOOG', q: { ratingAmp: 63, poles: 4, breakingKa: 25 } },
  { label: '125A 4P 36kA MCCB', expected: 'CM92108OOL1OG', q: { ratingAmp: 125, poles: 4, breakingKa: 36 } },
  { label: '200A 4P 36kA MCCB', expected: 'CM92109OON1OG', q: { ratingAmp: 200, poles: 4, breakingKa: 36 } },
  { label: '250A 4P 36kA MCCB', expected: 'CM92109OOP1OG', q: { ratingAmp: 250, poles: 4, breakingKa: 36 } },
  { label: '630A 4P 50kA MCCB', expected: 'CM94104OOT1OG', q: { ratingAmp: 630, poles: 4, breakingKa: 50 } },
  { label: 'Ground Fault GF1 100-200A', expected: 'ST27745OOOO', q: { keywords: ['GF1'] } },
  { label: 'Ground Fault GF2 200-400A', expected: 'ST27746OOOO', q: { keywords: ['GF2'] } },
];

async function main() {
  const doc = await prisma.productDocument.findFirst({
    where: { kind: 'PRICE_LIST', brand: 'LK', ingestStatus: 'COMPLETED' },
    orderBy: { id: 'desc' },
  });
  if (!doc) throw new Error('No ingested LK price list — run scripts/e2e-ingest.ts first');

  const pool = await loadPool({ documentId: doc.id });
  console.log(`Pool: ${pool.length} rows (document #${doc.id})\n`);

  let pass = 0;
  for (const c of CASES) {
    const ranked = rankCandidates(pool, { ...c.q, documentId: doc.id, limit: 5 });
    const topRank = ranked.findIndex((r) => r.item.catalogNo === c.expected);
    const top = ranked[0];
    const ok = topRank === 0;
    if (ok) pass++;
    console.log(
      `${ok ? 'PASS' : 'FAIL'}  ${c.label}\n` +
        `      expected ${c.expected}` +
        (topRank >= 0 ? ` (rank #${topRank + 1})` : ' (NOT in top 5)') +
        `\n      top: ${top ? `${top.item.catalogNo} @${top.item.listPrice} [${top.reasons.join(', ')}] score=${top.score}` : 'none'}`,
    );
  }
  console.log(`\n${pass}/${CASES.length} retrieval checks passed`);
  process.exit(pass === CASES.length ? 0 : 1);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
