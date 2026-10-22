/**
 * Offline check of the price-list page search — no Claude call, no cost.
 *
 * For every completed quote, the BOQ lines + the quote's rules are run through
 * the search, and each catalogue number in the quote's saved BOM (made by the
 * full-file engine) is looked up: is it printed on one of the pages the search
 * would have sent? 100% = Claude sees every product the full-file quote used.
 *
 *   npx tsx scripts/vectors-eval.ts [budgetChars] [sectionsPerQuery] [plan]
 *   ("plan" runs the real quote selection, which makes one paid Claude call per quote)
 */
import { prisma } from '../src/lib/prisma';
import { readInputs } from '../src/modules/quote/quote.reader';
import { getLlmProvider } from '../src/lib/llm';
import { selectQuotePages } from '../src/modules/vectors/vector.select';
import { catalogueSections, pagesWithCodes, queryLines, retrievePages } from '../src/modules/vectors/vector.service';

async function main() {
  const budget = Number(process.argv[2] ?? 120_000);
  const perQuery = Number(process.argv[3] ?? 2);
  // "plan": the real quote selection — Claude names sections from the outline (a paid call, ~$0.09).
  const plan = process.argv[4] === 'plan';
  const docs = await prisma.productDocument.findMany({ where: { kind: 'PRICE_LIST', aiStatus: 'COMPLETED' }, select: { id: true } });
  const documentIds = docs.map((d) => d.id);
  const quotes = await prisma.quote.findMany({ where: { status: 'COMPLETED', bomJson: { not: undefined } }, include: { documents: true } });
  let allCodes = 0;
  let allHit = 0;
  for (const q of quotes) {
    const boq = await readInputs(q.documents.map((d) => ({ fileName: d.fileName, mimeType: d.mimeType, path: d.storagePath })));
    const ids = Array.isArray(q.promptIds) ? (q.promptIds as number[]) : null;
    const rules = await prisma.brandPrompt.findMany({ where: ids ? { id: { in: ids } } : { train: true }, select: { content: true } });
    const boqQueries = queryLines(boq);
    const ruleQueries = queryLines(rules.map((r) => r.content).join('\n'));
    const queries = [...boqQueries, ...ruleQueries];
    const docRefs = await prisma.productDocument.findMany({ where: { id: { in: documentIds } } });
    const { pages } = plan
      ? await selectQuotePages({
          provider: await getLlmProvider(),
          docs: docRefs.map((d) => ({ ...d, aiFileId: d.aiFileId! })),
          boqText: boq,
          rulesText: rules.map((r) => r.content).join('\n\n'),
          customerNotes: '',
        })
      : await retrievePages({ documentIds, queries: boqQueries, ruleQueries, budgetChars: budget, depth: perQuery });
    const hay = pages.map((p) => p.content.replace(/\s+/g, ' ').toLowerCase()).join('\n');
    const codes = new Set<string>();
    for (const b of (q.bomJson as unknown as { feeders: { items: { modelNo: string | null }[] }[] }[]) ?? [])
      for (const f of b.feeders) for (const it of f.items) if (it.modelNo) codes.add(it.modelNo.trim());
    const missed = [...codes].filter((c) => !hay.includes(c.toLowerCase()));
    const chars = pages.reduce((s, p) => s + p.content.length, 0);
    // The smallest section set that would cover every code: the sections printing them.
    const sections = await catalogueSections(documentIds);
    const needed = new Map<string, number>();
    for (const p of await pagesWithCodes(documentIds, [...codes])) {
      const sec = sections.get(`${p.documentId}:${p.pageNo}`);
      if (sec) needed.set(sec.key, sec.chars);
    }
    const oracle = [...needed.values()].reduce((s, n) => s + n, 0);
    allCodes += codes.size;
    allHit += codes.size - missed.length;
    console.log(
      `quote ${q.id}: ${queries.length} queries → ${pages.length} pages, ${chars} chars (~${Math.round(chars * 0.6 / 1000)}k tokens; minimum covering all codes: ${needed.size} sections, ${oracle} chars); ` +
        `codes found ${codes.size - missed.length}/${codes.size}${missed.length ? ` — missed: ${missed.join(', ')}` : ''}`,
    );
  }
  console.log(`TOTAL distinct codes covered: ${allHit}/${allCodes} (${((100 * allHit) / Math.max(1, allCodes)).toFixed(1)}%)`);
  await prisma.$disconnect();
  process.exit(0);
}

main().catch(async (err) => {
  console.error(err);
  await prisma.$disconnect();
  process.exit(1);
});
