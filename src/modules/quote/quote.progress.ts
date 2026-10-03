/**
 * Live progress of a quote generation, kept in memory and polled by the client
 * (GET /quotes/:id/progress) while the pipeline runs. Generation happens in the
 * background after the quote row is created, so the UI can show the stage that
 * is really running — "matching batch 3 of 8" — instead of a timer.
 */

/** The pipeline's stages, in order. The client maps these to its wording. */
export type ProgressStage =
  | 'collect' // loading price lists, rules, reference text
  | 'read' // reading the BOQ files into text
  | 'extract' // AI: BOQ text → line items
  | 'retrieve' // code: candidate rows per line
  | 'match' // AI: catalog number per line (batched)
  | 'price' // code: pricing + accessory resolution
  | 'assemble' // grouping into boards/feeders, consolidation
  | 'save'; // writing lines, BOM and the reply

export const PROGRESS_STAGES: ProgressStage[] = [
  'collect',
  'read',
  'extract',
  'retrieve',
  'match',
  'price',
  'assemble',
  'save',
];

export interface Progress {
  stage: ProgressStage;
  /** Short live detail, e.g. "37 lines found" or "batch 3 of 8". */
  detail: string | null;
  /** 0–100, derived from the stage plus any sub-progress within it. */
  percent: number;
  updatedAt: string;
}

const live = new Map<number, Progress>();

/**
 * Record where a quote's generation is. `fraction` (0–1) is the progress within
 * the stage — the match stage reports its batch number this way.
 */
export function setProgress(
  quoteId: number,
  stage: ProgressStage,
  detail: string | null = null,
  fraction = 0,
): void {
  const idx = PROGRESS_STAGES.indexOf(stage);
  const per = 100 / PROGRESS_STAGES.length;
  const percent = Math.min(99, Math.round(idx * per + Math.max(0, Math.min(1, fraction)) * per));
  live.set(quoteId, { stage, detail, percent, updatedAt: new Date().toISOString() });
}

export function getProgress(quoteId: number): Progress | null {
  return live.get(quoteId) ?? null;
}

/** Forget a finished quote's progress (the quote row carries the final state). */
export function clearProgress(quoteId: number): void {
  live.delete(quoteId);
}
