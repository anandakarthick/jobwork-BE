/**
 * Renders a completed quote to an .xlsx buffer in the sample quote's layout:
 * Sr | Family | Make | Type | Catalog No. | Description | Qty | List Price |
 * Disc% | Rate | Amount, with a total row.
 *
 * Styling mirrors the reference sample (PTTA LT PANEL_Switchgear.xlsx):
 *   - mint header band (#E1FFFB), bold
 *   - cream zebra banding (#FFF1B7) on alternate data rows
 *   - the "Make" column is left unbanded (kept white on every row)
 *   - Rate / Amount / Total are live formulas so a Disc[%] typed into the
 *     sheet recalculates automatically.
 */
import ExcelJS from 'exceljs';
import type { PricedLine } from './quote.pipeline';

export interface QuoteMeta {
  title?: string | null;
  customerName: string;
  brand?: string | null;
}

const HEADER_FILL = 'FFE1FFFB'; // mint — header row
const BAND_FILL = 'FFFFF1B7'; // cream — alternate data rows
const BLACK = 'FF000000';
const MAKE_COL = 3; // "Make" column — never banded (matches the sample)

// Column letters for the formula-bearing columns (11-column layout).
const QTY_COL = 'G';
const LIST_COL = 'H';
const DISC_COL = 'I';
const RATE_COL = 'J';
const AMOUNT_COL = 'K';

// Columns 8..11 (List Price / Disc / Rate / Amount) render at 10pt like the sample.
function fontSize(col: number): number {
  return col >= 8 ? 10 : 11;
}

const round2 = (n: number) => Math.round(n * 100) / 100;

export async function buildQuoteWorkbook(meta: QuoteMeta, lines: PricedLine[]): Promise<Buffer> {
  const header = [
    'Sr.No.',
    'Family',
    'Make',
    'Type',
    'Catalog No.',
    'Component Description',
    'Qty',
    'List Price',
    'Disc [%]',
    'Rate',
    'Amount (INR)',
  ];

  // Only matched line items appear in the export; unmatched ("review") rows are dropped.
  const matched = lines.filter((l) => l.catalogNo != null && l.catalogNo !== '');

  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Quote');

  ws.addRow([`Quote: ${meta.title ?? meta.customerName}`]);
  ws.addRow([`Customer: ${meta.customerName}`, '', `Brand: ${meta.brand ?? ''}`]);
  ws.addRow([]);

  const headerRow = ws.addRow(header);
  headerRow.eachCell((cell, col) => {
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: HEADER_FILL } };
    cell.font = { name: 'Calibri', size: fontSize(col), bold: true, color: { argb: BLACK } };
  });

  const firstDataRow = headerRow.number + 1;
  let grandTotal = 0;
  matched.forEach((l, i) => {
    const row = ws.addRow([
      i + 1,
      l.family ?? '',
      l.make ?? '',
      l.type ?? '',
      l.catalogNo,
      l.description ?? l.requirement,
      l.quantity,
      l.listPrice ?? '',
      Number(l.discountPct),
      null,
      null,
    ]);
    const r = row.number;

    // Rate = List Price × (1 − Disc%/100); Amount = Rate × Qty. Kept as live
    // formulas (so a typed discount recalculates) BUT with a cached `result`
    // so the value always displays — even in viewers that don't recalculate.
    const list = l.listPrice != null ? Number(l.listPrice) : null;
    const disc = Number(l.discountPct) || 0;
    if (list != null && Number.isFinite(list)) {
      const rate = round2(list * (1 - disc / 100));
      const amount = round2(rate * l.quantity);
      grandTotal += amount;
      row.getCell(10).value = { formula: `${LIST_COL}${r}*(1-${DISC_COL}${r}/100)`, result: rate };
      row.getCell(11).value = { formula: `${RATE_COL}${r}*${QTY_COL}${r}`, result: amount };
    } else {
      row.getCell(10).value = '';
      row.getCell(11).value = '';
    }

    const banded = i % 2 === 1; // first data row unshaded, then alternate — like the sample
    row.eachCell({ includeEmpty: true }, (cell, col) => {
      cell.font = { name: 'Calibri', size: fontSize(col), color: { argb: BLACK } };
      if (banded && col !== MAKE_COL) {
        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: BAND_FILL } };
      }
    });
  });
  const lastDataRow = firstDataRow + matched.length - 1;

  ws.addRow([]);
  const totalRow = ws.addRow(['', '', '', '', '', '', '', '', '', 'Total (INR):', null]);
  totalRow.getCell(11).value =
    matched.length > 0
      ? { formula: `SUM(${AMOUNT_COL}${firstDataRow}:${AMOUNT_COL}${lastDataRow})`, result: round2(grandTotal) }
      : 0;
  totalRow.getCell(10).font = { name: 'Calibri', size: 10, bold: true, color: { argb: BLACK } };
  totalRow.getCell(11).font = { name: 'Calibri', size: 10, bold: true, color: { argb: BLACK } };

  const widths = [7, 20, 10, 14, 24, 42, 6, 12, 9, 12, 14];
  widths.forEach((w, i) => {
    ws.getColumn(i + 1).width = w;
  });

  return Buffer.from(await wb.xlsx.writeBuffer());
}
