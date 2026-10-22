/**
 * A/B check: page search vs the whole files, on the BOQs of completed quotes.
 * Each distinct BOQ is quoted again with page search ON (paid Claude calls,
 * nothing is saved to the quotes) and compared with the BOM the whole-file
 * engine saved: catalogue numbers, priced lines and the BOM value. Two saved
 * quotes of the same BOQ give the whole-file engine's own run-to-run spread.
 *
 *   npx tsx scripts/vectors-ab.ts [quoteId ...]      (default: every completed quote, one per BOQ)
 *   AB_MODEL=claude-sonnet-5-5 npx tsx scripts/vectors-ab.ts …   (another Claude model, this run only)
 */
import { prisma } from '../src/lib/prisma';
import { getEffectiveLlmConfig, getLlmProvider } from '../src/lib/llm';
import { createClaudeProvider } from '../src/lib/llm/providers/claude-provider';
import { readInputs } from '../src/modules/quote/quote.reader';
import { generateWithKnowledge } from '../src/modules/quote/quote.knowledge';
import { knowledgeRulesForQuote } from '../src/modules/companies/knowledge.service';
import type { BomBoard } from '../src/modules/quote/quote.bom';
import { writeFileSync } from 'fs';

interface Summary {
  codes: Map<string, number>;
  lines: number;
  priced: number;
  value: number;
}

function summarise(boards: BomBoard[]): Summary {
  const codes = new Map<string, number>();
  let lines = 0;
  let priced = 0;
  let value = 0;
  for (const b of boards)
    for (const f of b.feeders)
      for (const it of f.items) {
        lines++;
        const qty = it.qty * f.feederQty * b.boardQty;
        if (it.modelNo) {
          priced++;
          codes.set(it.modelNo, (codes.get(it.modelNo) ?? 0) + qty);
        }
        if (it.catalogPrice != null) value += it.catalogPrice * qty;
      }
  return { codes, lines, priced, value: Math.round(value) };
}

function compare(label: string, a: Summary, b: Summary) {
  const all = new Set([...a.codes.keys(), ...b.codes.keys()]);
  let same = 0;
  let qtyDiff = 0;
  const onlyA: string[] = [];
  const onlyB: string[] = [];
  for (const c of all) {
    const qa = a.codes.get(c);
    const qb = b.codes.get(c);
    if (qa != null && qb != null) {
      same++;
      if (qa !== qb) qtyDiff++;
    } else if (qa != null) onlyA.push(c);
    else onlyB.push(c);
  }
  const pct = (100 * same) / Math.max(1, a.codes.size);
  console.log(
    `${label}\n  lines ${a.lines} → ${b.lines}, priced ${a.priced} → ${b.priced}, value ₹${a.value.toLocaleString('en-IN')} → ₹${b.value.toLocaleString('en-IN')}` +
      ` (${(((b.value - a.value) / Math.max(1, a.value)) * 100).toFixed(1)}%)\n` +
      `  distinct codes: ${same} of ${a.codes.size} kept (${pct.toFixed(0)}%), ${qtyDiff} with a different qty` +
      (onlyA.length ? `\n  only in A: ${onlyA.join(', ')}` : '') +
      (onlyB.length ? `\n  only in B: ${onlyB.join(', ')}` : ''),
  );
}

async function main() {
  const ids = process.argv.slice(2).map(Number).filter(Number.isFinite);
  const quotes = await prisma.quote.findMany({
    where: { status: 'COMPLETED', ...(ids.length ? { id: { in: ids } } : {}) },
    include: { documents: true, customer: true },
    orderBy: { id: 'asc' },
  });

  // Baseline: the whole-file engine against itself (same BOQ file name quoted twice).
  const byBoq = new Map<string, typeof quotes>();
  for (const q of quotes) {
    const key = q.documents.map((d) => d.fileName).join('+');
    byBoq.set(key, [...(byBoq.get(key) ?? []), q]);
  }
  for (const [boq, qs] of byBoq)
    if (qs.length > 1)
      compare(
        `BASELINE whole files vs whole files — ${boq}: quote ${qs[0]!.id} (A) vs quote ${qs[1]!.id} (B)`,
        summarise(qs[0]!.bomJson as unknown as BomBoard[]),
        summarise(qs[1]!.bomJson as unknown as BomBoard[]),
      );

  const model = process.env.AB_MODEL;
  const provider = model ? createClaudeProvider({ ...(await getEffectiveLlmConfig()), anthropicModel: model }) : await getLlmProvider();
  console.log(`model: ${model ?? (await getEffectiveLlmConfig()).anthropicModel}`);
  const started = new Date();
  for (const [boq, qs] of byBoq) {
    const q = qs.at(-1)!;
    const brands = (q.brand ?? '').split(',').map((s) => s.trim()).filter(Boolean);
    const rules = await knowledgeRulesForQuote(brands, Array.isArray(q.promptIds) ? (q.promptIds as number[]) : null);
    const boqText = await readInputs(q.documents.map((d) => ({ fileName: d.fileName, mimeType: d.mimeType, path: d.storagePath })));
    const t0 = Date.now();
    const result = await generateWithKnowledge({
      provider,
      brands,
      ruleFileIds: rules.fileIds,
      rulesText: rules.inlineText,
      rulesAllText: rules.allText,
      customerNotes: '',
      boqText,
      customerName: q.customer.name,
      defaultDiscountPct: 0,
      pageSearch: true,
      onProgress: (_s, d) => console.log(`  … ${d}`),
    });
    const ps = result.pagesSent;
    console.log(
      `  page search: ${ps ? `${ps.pages}/${ps.totalPages} pages, ${ps.chars} chars, ${ps.plannedSections} planned sections` : 'NOT USED (whole files)'}; ${((Date.now() - t0) / 1000).toFixed(0)}s`,
    );
    compare(`A/B — ${boq}: saved quote ${q.id} whole files (A) vs page search (B)`, summarise(q.bomJson as unknown as BomBoard[]), summarise(result.boards));
    // Keep both BOMs line by line for review (AB_OUT_DIR, default: current folder).
    const out = `${process.env.AB_OUT_DIR ?? '.'}/ab-quote-${q.id}${model ? `-${model}` : ''}.json`;
    writeFileSync(out, JSON.stringify({ quoteId: q.id, boq, pagesSent: ps, before: q.bomJson, after: result.boards, voided: result.voided }, null, 1));
    console.log(`  saved ${out}`);
  }

  const usage = await prisma.llmUsage.groupBy({
    by: ['feature'],
    where: { createdAt: { gte: started } },
    _sum: { inputTokens: true, outputTokens: true, costUsd: true },
    _count: true,
  });
  // (the run's own calls: this script runs alone)
  console.log('\nCOST of this run (page search):');
  for (const u of usage)
    console.log(`  ${u.feature}: ${u._count} call(s), in ${u._sum.inputTokens}, out ${u._sum.outputTokens}, $${Number(u._sum.costUsd).toFixed(3)}`);
  await prisma.$disconnect();
  process.exit(0);
}

main().catch(async (err) => {
  console.error(err);
  await prisma.$disconnect();
  process.exit(1);
});
