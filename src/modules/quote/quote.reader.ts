/**
 * Reads a quote's input files (BOQ spreadsheets, spec/drawing PDFs, Word files,
 * photos or scans of a BOQ, plain text) into one text the LLM can reason over.
 * Files are read the same way as brand reference files — directly when they
 * carry text, by the AI (OCR) when they are images or scanned PDFs — and merged
 * under a header naming each source, so the model can tell them apart.
 */
import path from 'path';
import { readDocumentText } from '../price-list/price-list.text';

export interface InputFile {
  fileName: string;
  mimeType: string;
  path: string;
}

/**
 * Total characters of input handed to the model. Several attachments share this
 * budget; see `readInputs` for how it is split so no file is silently dropped.
 */
export const INPUT_BUDGET_CHARS = 120_000;

/** Read one input file to text; a failure becomes a note instead of an exception. */
export async function readInputFile(f: InputFile): Promise<string> {
  try {
    return (await readDocumentText({ fileName: f.fileName, mimeType: f.mimeType, path: f.path })).text;
  } catch (err) {
    return `[could not read ${f.fileName}: ${err instanceof Error ? err.message : 'error'}]`;
  }
}

/**
 * Read and merge all input files into a single labelled text. When the files
 * together exceed the budget, each one is cut back in proportion to its size
 * (never below a small floor), so a BOQ attached after a long spec still gets
 * through — instead of the tail files being lost to a hard cut at the end.
 */
export async function readInputs(files: InputFile[], maxChars = INPUT_BUDGET_CHARS): Promise<string> {
  const bodies = await Promise.all(files.map((f) => readInputFile(f)));
  const total = bodies.reduce((n, b) => n + b.length, 0);

  let trimmed = bodies;
  if (total > maxChars) {
    const floor = Math.min(8_000, Math.floor(maxChars / Math.max(1, files.length)));
    trimmed = bodies.map((b) => {
      const share = Math.max(floor, Math.floor((b.length / total) * maxChars));
      return b.length > share ? `${b.slice(0, share)}\n[… ${b.length - share} more characters not shown]` : b;
    });
  }

  return files
    .map((f, i) => `===== FILE: ${path.basename(f.fileName)} =====\n${trimmed[i]}`)
    .join('\n\n');
}
