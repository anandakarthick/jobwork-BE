/**
 * Exercises the DETERMINISTIC quote pipeline (retrieval + series + pricing +
 * consolidation + xlsx) against the real Project 2 LK data — everything except
 * the two LLM steps. Requirements are hard-coded to stand in for extraction,
 * including DUPLICATE breaker lines (multi-panel BOQ) and per-breaker accessories.
 * Run: npx tsx scripts/test-quote-pipeline.ts
 */
import fs from 'fs';
import path from 'path';
import { prisma } from '../src/lib/prisma';
import { loadPool } from '../src/modules/price-list/price-list.retrieval';
import {
  consolidateLines,
  deriveSeries,
  priceLines,
  retrieveCandidates,
  type MatchDecision,
  type Requirement,
} from '../src/modules/quote/quote.pipeline';
import { buildQuoteWorkbook } from '../src/modules/quote/quote.xlsx';

const R = (o: Partial<Requirement> & { lineNo: number; requirement: string }): Requirement => ({
  quantity: 1,
  isAccessory: false,
  parentLineNo: null,
  ratingAmp: null,
  poles: null,
  breakingKa: null,
  keywords: [],
  ...o,
});

// Duplicate 200A/125A lines simulate a multi-panel BOQ; lines 5-6 are accessories.
const REQUIREMENTS: Requirement[] = [
  R({ lineNo: 1, requirement: '630A 4P 50kA MCCB', quantity: 1, ratingAmp: 630, poles: 4, breakingKa: 50, keywords: ['mccb'] }),
  R({ lineNo: 2, requirement: '200A 4P 36kA MCCB', quantity: 7, ratingAmp: 200, poles: 4, breakingKa: 36, keywords: ['mccb'] }),
  R({ lineNo: 3, requirement: '200A 4P 36kA MCCB', quantity: 2, ratingAmp: 200, poles: 4, breakingKa: 36, keywords: ['mccb'] }),
  R({ lineNo: 4, requirement: '125A 4P 25kA MCCB', quantity: 7, ratingAmp: 125, poles: 4, breakingKa: 25, keywords: ['mccb'] }),
  R({ lineNo: 5, requirement: 'aux contact', quantity: 1, isAccessory: true, parentLineNo: 1, keywords: ['auxiliary', 'contact'] }),
  R({ lineNo: 6, requirement: 'shunt release', quantity: 1, isAccessory: true, parentLineNo: 2, keywords: ['shunt', 'release'] }),
];

async function main() {
  const doc = await prisma.productDocument.findFirstOrThrow({
    where: { kind: 'PRICE_LIST', brand: 'LK', ingestStatus: 'COMPLETED' },
    orderBy: { id: 'desc' },
  });
  const pool = await loadPool({ documentId: doc.id });
  const candidates = retrieveCandidates(pool, REQUIREMENTS);
  const series = deriveSeries(candidates, REQUIREMENTS);
  console.log('Derived series stems:', series);

  const matches: MatchDecision[] = REQUIREMENTS.map((r) => {
    const top = (candidates.get(r.lineNo) ?? [])[0];
    return { lineNo: r.lineNo, catalogNo: top?.catalogNo ?? null, confidence: 0.9, reason: 'top' };
  });

  const raw = priceLines(REQUIREMENTS, matches, candidates, 67);
  const consolidated = consolidateLines(raw);
  console.log(`\nBefore consolidation: ${raw.length} lines; after: ${consolidated.length} lines`);
  for (const l of consolidated) {
    console.log(
      `  #${l.lineNo} ${l.isAccessory ? 'ACC ' : 'brk '}${l.requirement.slice(0, 22).padEnd(22)} -> ` +
        `${l.catalogNo ?? 'REVIEW'} qty=${l.quantity} rate=${l.rate} amount=${l.amount}`,
    );
  }

  const buf = buildQuoteWorkbook({ title: 'P2 test', customerName: 'PTTA', brand: 'LK' }, consolidated);
  const out = path.join(process.env.TEMP || '.', 'p2-quote-consolidated.xlsx');
  fs.writeFileSync(out, buf);
  console.log(`\nxlsx: ${out} (${buf.length} bytes)`);

  // #3 check: the two 200A lines (qty 7 + 2) must collapse to one qty-9 line.
  const a200 = consolidated.find((l) => l.catalogNo === 'CM92109OON1OG');
  const dupOk = a200?.quantity === 9;
  console.log(`\nConsolidation (200A 7+2 -> 9): ${dupOk ? 'PASS' : 'FAIL (' + a200?.quantity + ')'}`);
  process.exit(dupOk ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); }).finally(() => prisma.$disconnect());
