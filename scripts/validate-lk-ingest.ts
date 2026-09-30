/**
 * Validation harness for the LK price-list parser. Parses the sample PDF and
 * checks the catalog->price rows that appear in the Project 2 sample quote.
 * Run: npx tsx scripts/validate-lk-ingest.ts
 */
import { parsePriceListFile } from '../src/modules/price-list/price-list.service';

const PDF =
  'C:/Users/USER/Downloads/MCCB & ACB (LK)/MCCB & ACB (LK)/Projects_LK(MCCB)/Project 2/Price list/LK_Switchgear Price list_June 2026.pdf';

// (catalogNo, expected list price) taken straight from the sample output xlsx.
const EXPECTED: [string, number][] = [
  ['CM91712OOKOOG', 15600],
  ['CM91712OOHOOG', 15600],
  ['CM92108OOL1OG', 32900],
  ['CM92109OON1OG', 43600],
  ['CM92109OOP1OG', 45000],
  ['CM94104OOT1OG', 91500],
];

async function main() {
  const t0 = Date.now();
  const items = await parsePriceListFile(PDF, 'LK');
  const secs = ((Date.now() - t0) / 1000).toFixed(1);

  const byCatalog = new Map<string, (typeof items)[number]>();
  for (const it of items) if (!byCatalog.has(it.catalogNo)) byCatalog.set(it.catalogNo, it);

  console.log(`Parsed ${items.length} priced items in ${secs}s`);
  console.log(`Distinct catalog numbers: ${byCatalog.size}\n`);

  let pass = 0;
  for (const [cat, price] of EXPECTED) {
    const it = byCatalog.get(cat);
    const ok = it && Number(it.listPrice) === price;
    if (ok) pass++;
    console.log(
      `${ok ? 'PASS' : 'FAIL'}  ${cat}  expected ${price}  got ${
        it ? `${it.listPrice} (${it.poles ?? '?'}P, ${it.ratingAmpMax ?? '?'}A, ${
          it.breakingKa ?? '?'
        }kA, p${it.pageNo})` : 'NOT FOUND'
      }`,
    );
  }
  console.log(`\n${pass}/${EXPECTED.length} checks passed`);
  process.exit(pass === EXPECTED.length ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
