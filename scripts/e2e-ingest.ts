/**
 * End-to-end DB check for price-list ingestion. Points a ProductDocument at the
 * sample LK PDF, ingests it, and reads a few rows back.
 * Run: npx tsx scripts/e2e-ingest.ts
 */
import { prisma } from '../src/lib/prisma';
import { ingestDocument } from '../src/modules/price-list/price-list.service';

const PDF =
  'C:/Users/USER/Downloads/MCCB & ACB (LK)/MCCB & ACB (LK)/Projects_LK(MCCB)/Project 2/Price list/LK_Switchgear Price list_June 2026.pdf';

async function main() {
  const category = await prisma.productCategory.findFirst({ where: { name: { contains: 'MCCB' } } });
  if (!category) throw new Error('No MCCB category found — run the seed first');
  const admin = await prisma.user.findFirstOrThrow({ where: { email: 'admin@jobwork.local' } });

  // Reuse a prior test doc if present, else create one pointing at the sample.
  let doc = await prisma.productDocument.findFirst({
    where: { categoryId: category.id, storedName: 'e2e-lk-price-list' },
  });
  if (!doc) {
    doc = await prisma.productDocument.create({
      data: {
        categoryId: category.id,
        fileName: 'LK_Switchgear Price list_June 2026.pdf',
        storedName: 'e2e-lk-price-list',
        mimeType: 'application/pdf',
        sizeBytes: 0,
        storagePath: PDF,
        kind: 'PRICE_LIST',
        brand: 'LK',
        createdById: admin.id,
      },
    });
  }

  console.log(`Ingesting document #${doc.id} (category "${category.name}", brand LK)…`);
  const result = await ingestDocument(doc.id);
  console.log('Ingest result:', result);

  const refreshed = await prisma.productDocument.findUniqueOrThrow({ where: { id: doc.id } });
  console.log('Doc status:', refreshed.ingestStatus, '| items:', refreshed.ingestedItemCount);

  const sample = await prisma.priceListItem.findFirst({
    where: { documentId: doc.id, catalogNo: 'CM94104OOT1OG' },
  });
  console.log('Sample row from DB:', {
    catalogNo: sample?.catalogNo,
    listPrice: sample?.listPrice?.toString(),
    poles: sample?.poles,
    ratingAmp: sample?.ratingAmp?.toString(),
    breakingKa: sample?.breakingKa?.toString(),
    page: sample?.pageNo,
    attributes: sample?.attributes,
  });

  const total = await prisma.priceListItem.count({ where: { documentId: doc.id } });
  console.log('Total rows in DB for this document:', total);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
