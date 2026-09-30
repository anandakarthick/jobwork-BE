/**
 * Feeder-grouped "Switchgear Report-Board" BOM export.
 *
 * Layout mirrors the customer's sample (Switchgear BOM details.xlsx):
 *   Row 1  — report title, merged A1:G1, dark-blue band, white bold Roboto 10
 *   Row 2  — Project Name | … | Offer Number | …           (light-grey band)
 *   Row 3  — Customer Details | … | Revision & Date | …     (light-grey band)
 *   Row 4  — column header (grey band, bold)
 *   then, per BOARD:
 *     Board Name | <board> | | | <qty> | | | | | | <price>   (grey; qty yellow/red)
 *       per FEEDER:
 *         Feeder Name | <feeder> | | | <feederQty> …          (grey band)
 *           1..n item rows                                     (light-grey band)
 *
 * Columns (11): Sl.No | Description | Model No | Make | Qty | Feeder Qty |
 *               Total Qty | Catalog price | Discount | Unit Rate | Price
 * Formulas kept live (with cached results): Total Qty = Qty×Feeder Qty,
 * Unit Rate = Catalog×(1−Disc%), Price = Unit Rate×Total Qty, Board price = Σ.
 */
import ExcelJS from 'exceljs';
import type { PricedLine } from './quote.pipeline';

export interface BomItem {
  description: string;
  modelNo: string | null;
  make: string | null;
  qty: number;
  catalogPrice: number | null;
  discountPct: number;
}
export interface BomFeeder {
  name: string;
  feederQty: number;
  items: BomItem[];
}
export interface BomBoard {
  name: string;
  boardQty: number;
  feeders: BomFeeder[];
}
export interface BomMeta {
  reportTitle?: string;
  projectName: string;
  offerNumber: string;
  customerName: string;
  revision: string;
}

const FONT = 'Roboto';
const TITLE_FILL = 'FF005B8C'; // dark blue — report title
const GREY_FILL = 'FFD9D9D9'; // header / board / feeder bands
const LIGHT_FILL = 'FFF2F2F2'; // meta + item rows
const QTY_FILL = 'FFFFFF00'; // board-qty highlight (yellow)
const WHITE = 'FFFFFFFF';
const BLACK = 'FF000000';
const RED = 'FFFF0000';
const COLS = 11;
const round2 = (n: number) => Math.round(n * 100) / 100;

function fill(argb: string): ExcelJS.Fill {
  return { type: 'pattern', pattern: 'solid', fgColor: { argb } };
}

// Thin black border on every side — matches the sample's gridded look.
const THIN = { style: 'thin' as const, color: { argb: BLACK } };
const BORDER: Partial<ExcelJS.Borders> = { top: THIN, left: THIN, bottom: THIN, right: THIN };

/**
 * Turn the pipeline's (UN-consolidated) priced lines into the feeder-grouped BOM
 * structure. Each MCCB line is a FEEDER (feederQty = its quantity, items count 1
 * per feeder); its accessories nest under it by parentLineNo; every other line
 * (lamps, meter, MCB, SFU, review items) goes into a per-board "General" feeder.
 * Grouped by `board`. Do NOT pass consolidated lines — feeders would be lost.
 */
export function groupIntoBom(lines: PricedLine[]): BomBoard[] {
  const toItem = (l: PricedLine, qty: number): BomItem => ({
    description: l.description ?? l.requirement,
    modelNo: l.catalogNo,
    make: l.make || null,
    qty,
    catalogPrice: l.listPrice != null ? Number(l.listPrice) : null,
    discountPct: Number(l.discountPct) || 0,
  });
  const isMccb = (l: PricedLine) =>
    !l.isAccessory && /\bMCCB\b/i.test(`${l.family ?? ''} ${l.requirement} ${l.description ?? ''}`);

  const byBoard = new Map<string, PricedLine[]>();
  for (const l of lines) {
    const b = (l.board && l.board.trim()) || 'Panel';
    (byBoard.get(b) ?? byBoard.set(b, []).get(b)!).push(l);
  }

  const boards: BomBoard[] = [];
  for (const [boardName, bl] of byBoard) {
    const feeders: BomFeeder[] = [];
    const used = new Set<number>();
    let incomer: { feeder: BomFeeder; rating: number } | null = null;
    for (const m of bl.filter(isMccb)) {
      const feederQty = Math.max(1, Math.round(m.quantity || 1));
      const items: BomItem[] = [toItem(m, 1)];
      if (m.lineRef != null) used.add(m.lineRef);
      for (const a of bl) {
        if (a.isAccessory && a.parentLineNo != null && a.parentLineNo === m.lineRef) {
          const per = Math.max(1, Math.round((a.quantity || feederQty) / feederQty));
          items.push(toItem(a, per));
          if (a.lineRef != null) used.add(a.lineRef);
        }
      }
      const rating = Number(/(\d+)\s*A\b/i.exec(m.requirement)?.[1] ?? 0);
      const feeder = { name: rating ? `MCCB ${rating} A` : m.requirement.slice(0, 40), feederQty, items };
      feeders.push(feeder);
      // The incomer = highest-rated MCCB in the board; panel-common items sit under it.
      if (!incomer || rating > incomer.rating) incomer = { feeder, rating };
    }
    // Panel-level items that belong to no specific feeder (meter, CT, ELR, SPD,
    // SFU, busbar) go UNDER the incomer feeder — as the reference BOM does — rather
    // than a separate "General / Common" group.
    const rest = bl.filter((l) => l.lineRef == null || !used.has(l.lineRef));
    if (rest.length && incomer) {
      const fq = incomer.feeder.feederQty || 1;
      for (const l of rest) {
        incomer.feeder.items.push(toItem(l, Math.max(1, Math.round((l.quantity || 1) / fq))));
      }
    }
    boards.push({ name: boardName, boardQty: 1, feeders });
  }
  return boards;
}

export async function buildBomWorkbook(meta: BomMeta, boards: BomBoard[]): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Switchgear Report-Board');

  const paint = (row: ExcelJS.Row, argb: string, bold: boolean, color = BLACK) => {
    for (let c = 1; c <= COLS; c++) {
      const cell = row.getCell(c);
      cell.fill = fill(argb);
      cell.font = { name: FONT, size: 10, bold, color: { argb: color } };
      cell.border = BORDER;
    }
  };

  // Row 1 — title band (merged A1:G1, but paint all 11 for a clean band).
  const title = ws.addRow([meta.reportTitle ?? 'Switchgear Report-Board']);
  paint(title, TITLE_FILL, true, WHITE);
  ws.mergeCells(title.number, 1, title.number, 7);

  // Rows 2-3 — project / customer meta.
  const m1 = ws.addRow(['Project Name', meta.projectName, 'Offer Number', meta.offerNumber]);
  paint(m1, LIGHT_FILL, false);
  const m2 = ws.addRow(['Customer Details', meta.customerName, 'Revision & Date', meta.revision]);
  paint(m2, LIGHT_FILL, false);

  // Row 4 — column header.
  const header = ws.addRow([
    'Sl.No', 'Description', 'Model No', 'Make', 'Qty',
    'Feeder Qty', 'Total Qty', 'Catalog price', 'Discount', 'Unit Rate', 'Price',
  ]);
  paint(header, GREY_FILL, true);

  for (const board of boards) {
    const boardRow = ws.addRow(['Board Name', board.name, '', '', board.boardQty, '', '', '', '', '', null]);
    paint(boardRow, GREY_FILL, true);
    // Board qty cell: yellow highlight, red bold text (matches the sample).
    boardRow.getCell(5).fill = fill(QTY_FILL);
    boardRow.getCell(5).font = { name: FONT, size: 10, bold: true, color: { argb: RED } };
    const priceRowNos: number[] = [];

    for (const feeder of board.feeders) {
      const feederRow = ws.addRow(['Feeder Name', feeder.name, '', '', feeder.feederQty, '', '', '', '', '', '']);
      paint(feederRow, GREY_FILL, true);

      feeder.items.forEach((it, i) => {
        const row = ws.addRow([
          i + 1,
          it.description,
          it.modelNo ?? '',
          it.make ?? '',
          it.qty,
          feeder.feederQty,
          null, // Total Qty (formula)
          it.catalogPrice ?? '',
          it.discountPct || 0,
          null, // Unit Rate (formula)
          null, // Price (formula)
        ]);
        const r = row.number;
        const cat = it.catalogPrice != null && Number.isFinite(it.catalogPrice) ? it.catalogPrice : null;
        const totalQty = it.qty * feeder.feederQty;
        row.getCell(7).value = { formula: `E${r}*F${r}`, result: totalQty };
        if (cat != null) {
          const rate = round2(cat * (1 - (it.discountPct || 0) / 100));
          const price = round2(rate * totalQty);
          row.getCell(10).value = { formula: `H${r}*(1-I${r}/100)`, result: rate };
          row.getCell(11).value = { formula: `J${r}*G${r}`, result: price };
          priceRowNos.push(r);
        } else {
          row.getCell(10).value = '';
          row.getCell(11).value = '';
        }
        paint(row, LIGHT_FILL, false);
        // Right-align the numeric columns for readability.
        for (let c = 5; c <= COLS; c++) row.getCell(c).alignment = { horizontal: 'right' };
      });
    }
    // Board total price = Σ of its item prices.
    if (priceRowNos.length) {
      const sum = priceRowNos.map((n) => `K${n}`).join('+');
      boardRow.getCell(11).value = { formula: sum, result: undefined };
    }
  }

  const widths = [15.7, 57.3, 22.3, 12.3, 7.4, 15.7, 14.3, 15, 15, 15, 15];
  widths.forEach((w, i) => (ws.getColumn(i + 1).width = w));

  return Buffer.from(await wb.xlsx.writeBuffer());
}
