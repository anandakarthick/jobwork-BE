/**
 * Reads a quote's input files (BOQ spreadsheets, spec/drawing PDFs, text) into
 * plain text the LLM can reason over. Multiple files are merged, each under a
 * header naming its source, so the model can tell them apart.
 */
import fs from 'fs/promises';
import path from 'path';
import * as XLSX from 'xlsx';
import { extractPages } from '../../lib/pdf/extract-rows';

export interface InputFile {
  fileName: string;
  mimeType: string;
  path: string;
}

/** Turn an Excel workbook into CSV-ish text, one block per sheet. */
async function readXlsx(filePath: string): Promise<string> {
  const buf = await fs.readFile(filePath);
  const wb = XLSX.read(buf, { type: 'buffer' });
  const parts: string[] = [];
  for (const name of wb.SheetNames) {
    const ws = wb.Sheets[name];
    if (!ws) continue;
    const csv = XLSX.utils.sheet_to_csv(ws, { blankrows: false });
    if (csv.trim()) parts.push(`[sheet: ${name}]\n${csv}`);
  }
  return parts.join('\n\n');
}

/** Extract a PDF as coordinate-reconstructed row text (layout preserved). */
async function readPdf(filePath: string): Promise<string> {
  const data = new Uint8Array(await fs.readFile(filePath));
  const pages = await extractPages(data);
  return pages
    .map((p) => `[page ${p.pageNo}]\n${p.rows.map((r) => r.text).join('\n')}`)
    .join('\n\n');
}

function isXlsx(f: InputFile): boolean {
  return /sheet|excel|xlsx|xls|csv/i.test(f.mimeType) || /\.(xlsx|xls|csv)$/i.test(f.fileName);
}
function isPdf(f: InputFile): boolean {
  return /pdf/i.test(f.mimeType) || /\.pdf$/i.test(f.fileName);
}

/** Read one input file to text, choosing the parser by type. */
export async function readInputFile(f: InputFile): Promise<string> {
  try {
    if (isXlsx(f)) return await readXlsx(f.path);
    if (isPdf(f)) return await readPdf(f.path);
    // Fallback: treat as UTF-8 text.
    return await fs.readFile(f.path, 'utf8');
  } catch (err) {
    return `[could not read ${f.fileName}: ${err instanceof Error ? err.message : 'error'}]`;
  }
}

/** Read and merge all input files into a single labelled text blob. */
export async function readInputs(files: InputFile[]): Promise<string> {
  const blocks = await Promise.all(
    files.map(async (f) => {
      const body = await readInputFile(f);
      return `===== FILE: ${path.basename(f.fileName)} =====\n${body}`;
    }),
  );
  return blocks.join('\n\n');
}
