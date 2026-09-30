/**
 * Generic PDF text extraction that PRESERVES table layout.
 *
 * `pdfjs` (like most PDF text extractors) emits text runs in an order that
 * loses 2D table structure — columns get flattened, so a naive line reader
 * cannot tell which price belongs to which catalog number. Here we keep each
 * run's (x, y) position and rebuild the visual rows: cluster runs by their
 * vertical position, then sort each row left-to-right by x. The result is the
 * table as a human sees it, which the price-list parser can walk reliably.
 */

// pdfjs-dist v4 is ESM-only; this file is compiled to CommonJS, so load it
// through a dynamic import (works under both tsx and compiled dist).
type PdfjsModule = typeof import('pdfjs-dist/legacy/build/pdf.mjs');
let pdfjsPromise: Promise<PdfjsModule> | null = null;
function loadPdfjs(): Promise<PdfjsModule> {
  if (!pdfjsPromise) {
    pdfjsPromise = import('pdfjs-dist/legacy/build/pdf.mjs') as Promise<PdfjsModule>;
  }
  return pdfjsPromise;
}

/** A single positioned text run on a page. */
export interface Word {
  str: string;
  /** Left edge, in PDF points from the left of the page. */
  x: number;
  /** Distance from the TOP of the page, in points (larger = further down). */
  top: number;
}

/** One reconstructed visual row: words sharing a vertical band, left-to-right. */
export interface Row {
  /** Vertical position (distance from top) of the row. */
  top: number;
  words: Word[];
  /** The row's words joined with single spaces — convenient for matching. */
  text: string;
}

export interface Page {
  pageNo: number;
  width: number;
  height: number;
  rows: Row[];
}

/** Words whose tops differ by <= this many points are treated as one row. */
const ROW_TOLERANCE = 3.5;

/** Rebuild visual rows from positioned words via vertical clustering. */
function clusterRows(words: Word[]): Row[] {
  const sorted = [...words].sort((a, b) => a.top - b.top || a.x - b.x);
  const clusters: { top: number; words: Word[] }[] = [];

  for (const w of sorted) {
    const hit = clusters.find((c) => Math.abs(c.top - w.top) <= ROW_TOLERANCE);
    if (hit) {
      hit.words.push(w);
      // Rolling average keeps the band centred as words are added.
      hit.top = (hit.top * (hit.words.length - 1) + w.top) / hit.words.length;
    } else {
      clusters.push({ top: w.top, words: [w] });
    }
  }

  return clusters
    .sort((a, b) => a.top - b.top)
    .map((c) => {
      const ws = c.words.sort((a, b) => a.x - b.x);
      return { top: Math.round(c.top), words: ws, text: ws.map((w) => w.str).join(' ') };
    });
}

/**
 * Read a PDF (given its bytes) and return every page as reconstructed rows.
 * Pass a page filter to limit work when only some pages are needed.
 */
export async function extractPages(
  data: Uint8Array,
  opts: { pageFilter?: (pageNo: number) => boolean } = {},
): Promise<Page[]> {
  const pdfjs = await loadPdfjs();
  const doc = await pdfjs.getDocument({ data, useSystemFonts: true, isEvalSupported: false })
    .promise;

  const pages: Page[] = [];
  try {
    for (let n = 1; n <= doc.numPages; n++) {
      if (opts.pageFilter && !opts.pageFilter(n)) continue;
      const page = await doc.getPage(n);
      const viewport = page.getViewport({ scale: 1 });
      const content = await page.getTextContent();

      const words: Word[] = [];
      for (const item of content.items) {
        // TextItem has `str` + `transform`; TextMarkedContent does not.
        if (!('str' in item)) continue;
        const str = item.str.trim();
        if (!str) continue;
        const x = item.transform[4];
        // pdfjs y-origin is the page bottom; convert to distance-from-top.
        const top = viewport.height - item.transform[5];
        words.push({ str, x, top });
      }

      pages.push({
        pageNo: n,
        width: viewport.width,
        height: viewport.height,
        rows: clusterRows(words),
      });
      // Let pdfjs release per-page resources.
      page.cleanup();
    }
  } finally {
    await doc.destroy();
  }

  return pages;
}
