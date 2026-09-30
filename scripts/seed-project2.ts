/**
 * Seeds the data needed to test Get Quote against the sample "Project 2":
 *  - ensures the MCCB category supports brand LK,
 *  - ensures the LK price list is attached + ingested (via e2e-ingest doc),
 *  - creates a customer to quote for.
 * Prints the IDs to use in the Get Quote form. Run: npx tsx scripts/seed-project2.ts
 */
import { prisma } from '../src/lib/prisma';

async function main() {
  const category = await prisma.productCategory.findFirst({ where: { name: { contains: 'MCCB' } } });
  if (!category) throw new Error('No MCCB category — run `npm run seed` first');

  const brands = Array.isArray(category.brands) ? (category.brands as string[]) : [];
  if (!brands.includes('LK')) {
    await prisma.productCategory.update({
      where: { id: category.id },
      data: { brands: [...brands, 'LK'] },
    });
    console.log('Added LK to MCCB category brands.');
  }

  const priceList = await prisma.productDocument.findFirst({
    where: { categoryId: category.id, brand: 'LK', kind: 'PRICE_LIST', ingestStatus: 'COMPLETED' },
    orderBy: { id: 'desc' },
  });

  const existing = await prisma.customer.findFirst({ where: { name: 'PTTA LT Panel (Project 2)' } });
  const admin = await prisma.user.findFirstOrThrow({ where: { email: 'admin@jobwork.local' } });
  const customer =
    existing ??
    (await prisma.customer.create({
      data: {
        name: 'PTTA LT Panel (Project 2)',
        email: 'projects@example.com',
        createdById: admin.id,
      },
    }));

  console.log('\n=== Get Quote test data ===');
  console.log('customerId :', customer.id, `(${customer.name})`);
  console.log('categoryId :', category.id, `(${category.name})`);
  console.log('brand      : LK');
  console.log(
    'price list :',
    priceList ? `doc #${priceList.id} — ${priceList.ingestedItemCount} items ingested` : 'NOT INGESTED — run scripts/e2e-ingest.ts',
  );
  console.log(
    '\nInput files to upload (Project 2/Input): SubLT Panel PTTA_BOQ.xlsx, Technicalspecification3004.pdf, TenderDrawing3004.pdf',
  );
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
