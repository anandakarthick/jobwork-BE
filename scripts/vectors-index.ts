/**
 * Build the price-list page search index (pgvector) for files that are already
 * trained into Claude — the same text as training, no Claude call, no cost.
 * New trainings index themselves; this is for files trained before the index
 * existed, or to rebuild it.
 *
 *   npx tsx scripts/vectors-index.ts            (every trained price list)
 *   npx tsx scripts/vectors-index.ts 5 6        (only these document ids)
 */
import { prisma } from '../src/lib/prisma';
import { readDocumentText, readPdfTextWithOcr } from '../src/modules/price-list/price-list.text';
import { indexDocumentVectors } from '../src/modules/vectors/vector.service';

async function main() {
  const ids = process.argv.slice(2).map(Number).filter(Number.isFinite);
  const docs = await prisma.productDocument.findMany({
    where: { kind: 'PRICE_LIST', aiStatus: 'COMPLETED', aiFileId: { not: null }, ...(ids.length ? { id: { in: ids } } : {}) },
    orderBy: { id: 'asc' },
  });
  for (const doc of docs) {
    const started = Date.now();
    const src = { fileName: doc.fileName, mimeType: doc.mimeType, path: doc.storagePath };
    const text = (await readPdfTextWithOcr(src))?.text ?? (await readDocumentText(src)).text;
    const r = await indexDocumentVectors(doc, text);
    console.log(`#${doc.id} ${doc.brand} — ${doc.name || doc.fileName}: ${r.pages} pages, ${r.chunks} chunks (${((Date.now() - started) / 1000).toFixed(0)}s)`);
  }
  await prisma.$disconnect();
  process.exit(0);
}

main().catch(async (err) => {
  console.error(err);
  await prisma.$disconnect();
  process.exit(1);
});
