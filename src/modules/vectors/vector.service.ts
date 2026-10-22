/**
 * Price-list page search (PostgreSQL + pgvector).
 *
 * Indexing (part of Train / Train again): the complete text of a price list —
 * the same text that is uploaded to Claude — is split into its pages ("[page N]"
 * marks from scripts/pdf_text.py) and each page into small chunks. Every chunk
 * gets a local embedding (scripts/embed.py, no API cost) and is stored in
 * price_chunks; the pages themselves in price_pages.
 *
 * Retrieval (at quote time): every line of the BOQ and of the chosen rules is a
 * query. Each query ranks the chunks twice — by meaning (pgvector cosine) and by
 * words (BM25 over the same chunks, so ratings and catalogue codes count) — and
 * the two rankings are fused. The pages holding the best chunks are what Claude
 * reads. Nothing about the products is known to this code: the queries come from
 * the BOQ and the rules, the answers from the price lists.
 */
import { spawn } from 'child_process';
import path from 'path';
import { toVectorLiteral, vectorDb, vectorDbConfigured } from '../../lib/vector-db';

export const EMBED_MODEL = 'BAAI/bge-base-en-v1.5';

/** A chunk holds a few table rows — small enough for the embedding model's window. */
const CHUNK_CHARS = 900;
/** Lines carried over from the previous chunk so a row split across two stays whole. */
const CHUNK_OVERLAP_LINES = 1;
/** Reciprocal-rank-fusion constant (the usual 60). */
const RRF_K = 60;
/** How deep each ranking is read per query. */
const RANK_DEPTH = 15;

// ---------- Splitting ----------

/** "[page N]" sections of the extracted text → page number → text. */
export function splitPages(text: string): { pageNo: number; content: string }[] {
  const parts = text.split(/^\[page (\d+)\]$/m);
  const pages: { pageNo: number; content: string }[] = [];
  for (let i = 1; i < parts.length; i += 2) {
    const content = (parts[i + 1] ?? '').trim();
    if (content) pages.push({ pageNo: Number(parts[i]), content });
  }
  if (pages.length) return pages;
  // No page marks (a non-PDF file): fixed-size sections stand in for pages.
  const lines = text.split('\n');
  let buf: string[] = [];
  let size = 0;
  for (const line of lines) {
    buf.push(line);
    size += line.length + 1;
    if (size >= 3000) {
      pages.push({ pageNo: pages.length + 1, content: buf.join('\n').trim() });
      buf = [];
      size = 0;
    }
  }
  if (buf.join('').trim()) pages.push({ pageNo: pages.length + 1, content: buf.join('\n').trim() });
  return pages;
}

/** A page → overlapping chunks of whole lines, each opened by the page's heading line. */
export function chunkPage(content: string): string[] {
  const lines = content.split('\n').map((l) => l.trim()).filter(Boolean);
  if (!lines.length) return [];
  const heading = lines[0]!.slice(0, 160);
  const chunks: string[] = [];
  let start = 0;
  while (start < lines.length) {
    let end = start;
    let size = 0;
    while (end < lines.length && (end === start || size + lines[end]!.length < CHUNK_CHARS)) {
      size += lines[end]!.length + 1;
      end++;
    }
    const body = lines.slice(start, end).join('\n');
    chunks.push(start === 0 ? body : `${heading}\n${body}`);
    if (end >= lines.length) break;
    start = Math.max(start + 1, end - CHUNK_OVERLAP_LINES);
  }
  return chunks;
}

// ---------- Embeddings (local Python) ----------

/** Embed texts with the local model. kind "query" for searches, "passage" for the index. */
export async function embed(texts: string[], kind: 'query' | 'passage'): Promise<number[][]> {
  if (!texts.length) return [];
  const script = path.resolve(process.cwd(), 'scripts', 'embed.py');
  const python = process.env.PYTHON_BIN || (process.platform === 'win32' ? 'py' : 'python3');
  const args = [...(python === 'py' ? ['-3'] : []), script];
  return new Promise((resolve, reject) => {
    const child = spawn(python, args, { windowsHide: true });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += String(d)));
    child.stderr.on('data', (d) => (stderr += String(d)));
    child.on('error', (err) => reject(new Error(`Could not start Python for embeddings: ${err.message}`)));
    child.on('close', (code) => {
      if (code !== 0) {
        const why = stderr.trim().split('\n').slice(-3).join(' | ');
        return reject(new Error(`Embedding failed (scripts/embed.py): ${why || `exit ${code}`}`));
      }
      try {
        const out = JSON.parse(stdout) as { vectors: number[][] };
        if (out.vectors.length !== texts.length) throw new Error('vector count mismatch');
        resolve(out.vectors);
      } catch (err) {
        reject(new Error(`Embedding output unreadable: ${(err as Error).message}`));
      }
    });
    child.stdin.end(JSON.stringify({ model: EMBED_MODEL, kind, texts }), 'utf8');
  });
}

// ---------- Index ----------

/** Index one price list (replaces any previous index of that document). */
export async function indexDocumentVectors(
  doc: { id: number; brand: string | null; name: string | null; fileName: string; aiFileId: string | null },
  text: string,
): Promise<{ pages: number; chunks: number }> {
  const pages = splitPages(text);
  const chunks = pages.flatMap((p) => chunkPage(p.content).map((content) => ({ pageNo: p.pageNo, content })));
  const vectors = await embed(
    chunks.map((c) => c.content),
    'passage',
  );
  const db = await vectorDb();
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    await client.query('DELETE FROM price_documents WHERE document_id = $1', [doc.id]);
    await client.query(
      `INSERT INTO price_documents (document_id, brand, name, ai_file_id, model, pages, chunks, chars)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [doc.id, doc.brand ?? '', doc.name || doc.fileName, doc.aiFileId, EMBED_MODEL, pages.length, chunks.length, text.length],
    );
    for (const p of pages) {
      await client.query('INSERT INTO price_pages (document_id, page_no, content) VALUES ($1, $2, $3)', [
        doc.id,
        p.pageNo,
        p.content,
      ]);
    }
    for (let i = 0; i < chunks.length; i++) {
      await client.query(
        'INSERT INTO price_chunks (document_id, page_no, content, embedding) VALUES ($1, $2, $3, $4::vector)',
        [doc.id, chunks[i]!.pageNo, chunks[i]!.content, toVectorLiteral(vectors[i]!)],
      );
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
  lexicalCache.delete(doc.id);
  return { pages: pages.length, chunks: chunks.length };
}

/** Drop a document's index (file deleted or untrained). */
export async function forgetDocumentVectors(documentId: number): Promise<void> {
  if (!vectorDbConfigured()) return;
  const db = await vectorDb();
  await db.query('DELETE FROM price_documents WHERE document_id = $1', [documentId]);
  lexicalCache.delete(documentId);
}

/**
 * Whether every given document is indexed from its CURRENT training (the index
 * records the Claude file id it was built with; a re-train changes the id).
 */
export async function vectorsReadyFor(docs: { id: number; aiFileId: string }[]): Promise<boolean> {
  if (!vectorDbConfigured() || !docs.length) return false;
  try {
    const db = await vectorDb();
    const { rows } = await db.query<{ document_id: number; ai_file_id: string | null; model: string }>(
      'SELECT document_id, ai_file_id, model FROM price_documents WHERE document_id = ANY($1)',
      [docs.map((d) => d.id)],
    );
    const byId = new Map(rows.map((r) => [r.document_id, r]));
    return docs.every((d) => {
      const r = byId.get(d.id);
      return r && r.ai_file_id === d.aiFileId && r.model === EMBED_MODEL;
    });
  } catch (err) {
    console.warn('[vectors] status check failed:', (err as Error).message);
    return false;
  }
}

/** Index summary per document, for the brand page. */
export async function vectorStatus(documentIds: number[]) {
  if (!vectorDbConfigured() || !documentIds.length) return new Map<number, { aiFileId: string | null; pages: number; indexedAt: Date }>();
  const db = await vectorDb();
  const { rows } = await db.query<{ document_id: number; ai_file_id: string | null; pages: number; indexed_at: Date }>(
    'SELECT document_id, ai_file_id, pages, indexed_at FROM price_documents WHERE document_id = ANY($1)',
    [documentIds],
  );
  return new Map(rows.map((r) => [r.document_id, { aiFileId: r.ai_file_id, pages: r.pages, indexedAt: r.indexed_at }]));
}

// ---------- Lexical ranking (BM25 over the indexed chunks) ----------

/** Lower-case word tokens; "630A" also yields "630" and "a"-less parts so either spelling meets. */
export function tokens(text: string): string[] {
  const out: string[] = [];
  for (const raw of text.toLowerCase().match(/[a-z0-9]+(?:\.[0-9]+)?/g) ?? []) {
    if (raw.length >= 2) out.push(raw);
    const parts = raw.match(/[a-z]+|[0-9]+(?:\.[0-9]+)?/g) ?? [];
    if (parts.length > 1) for (const p of parts) if (p.length >= 2 || /\d/.test(p)) out.push(p);
  }
  return out;
}

interface LexChunk {
  id: number;
  documentId: number;
  pageNo: number;
  tf: Map<string, number>;
  len: number;
}
interface LexIndex {
  stamp: string;
  chunks: LexChunk[];
}
const lexicalCache = new Map<number, LexIndex>();

async function lexicalIndex(documentIds: number[]): Promise<LexChunk[]> {
  const db = await vectorDb();
  const { rows: stamps } = await db.query<{ document_id: number; indexed_at: Date }>(
    'SELECT document_id, indexed_at FROM price_documents WHERE document_id = ANY($1)',
    [documentIds],
  );
  const all: LexChunk[] = [];
  for (const s of stamps) {
    const stamp = s.indexed_at.toISOString();
    let hit = lexicalCache.get(s.document_id);
    if (!hit || hit.stamp !== stamp) {
      const { rows } = await db.query<{ id: string; page_no: number; content: string }>(
        'SELECT id, page_no, content FROM price_chunks WHERE document_id = $1',
        [s.document_id],
      );
      hit = {
        stamp,
        chunks: rows.map((r) => {
          const tf = new Map<string, number>();
          const toks = tokens(r.content);
          for (const t of toks) tf.set(t, (tf.get(t) ?? 0) + 1);
          return { id: Number(r.id), documentId: s.document_id, pageNo: r.page_no, tf, len: toks.length };
        }),
      };
      lexicalCache.set(s.document_id, hit);
    }
    all.push(...hit.chunks);
  }
  return all;
}

function bm25Ranker(chunks: LexChunk[]) {
  const n = chunks.length || 1;
  const avgLen = chunks.reduce((s, c) => s + c.len, 0) / n || 1;
  const df = new Map<string, number>();
  for (const c of chunks) for (const t of c.tf.keys()) df.set(t, (df.get(t) ?? 0) + 1);
  const k1 = 1.2;
  const b = 0.75;
  return (query: string): LexChunk[] => {
    const q = [...new Set(tokens(query))];
    const scored: { c: LexChunk; s: number }[] = [];
    for (const c of chunks) {
      let s = 0;
      for (const t of q) {
        const f = c.tf.get(t);
        if (!f) continue;
        const d = df.get(t) ?? 0;
        const idf = Math.log(1 + (n - d + 0.5) / (d + 0.5));
        s += idf * ((f * (k1 + 1)) / (f + k1 * (1 - b + (b * c.len) / avgLen)));
      }
      if (s > 0) scored.push({ c, s });
    }
    return scored.sort((x, y) => y.s - x.s).slice(0, RANK_DEPTH).map((x) => x.c);
  };
}

// ---------- Retrieval ----------

export interface RetrievedPage {
  documentId: number;
  pageNo: number;
  content: string;
}

export interface RetrieveOptions {
  documentIds: number[];
  /** The lines that must be covered: the BOQ's lines (or the chat message). */
  queries: string[];
  /** The chosen rules' lines — searched after the BOQ (what the rules add, e.g. accessories). */
  ruleQueries?: string[];
  /** Total characters of page text to return. */
  budgetChars: number;
  /** Sections taken per query, best first (every query's 1st, then every query's 2nd, …). */
  depth?: number;
  /** Sections that must be sent (chosen from the outline) — taken before any search hit. */
  include?: Section[];
  /** Hard cap for the included sections (they may go past budgetChars, never past this). */
  maxChars?: number;
  /** Pages already chosen — kept, and not counted as new. */
  alreadyChosen?: { documentId: number; pageNo: number }[];
}

const pageKey = (documentId: number, pageNo: number) => `${documentId}:${pageNo}`;

/** Each query's pages, best first — vector and BM25 rankings fused per query. */
async function rankPagesPerQuery(documentIds: number[], queries: string[]): Promise<{ documentId: number; pageNo: number }[][]> {
  if (!queries.length) return [];
  const db = await vectorDb();
  const lex = bm25Ranker(await lexicalIndex(documentIds));
  const vectors = await embed(queries, 'query');
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    // Filtered HNSW scans need a wider candidate list to fill the LIMIT.
    await client.query('SET LOCAL hnsw.ef_search = 200');
    const perQuery: { documentId: number; pageNo: number }[][] = [];
    for (let qi = 0; qi < queries.length; qi++) {
      const { rows } = await client.query<{ id: string; document_id: number; page_no: number }>(
        `SELECT id, document_id, page_no FROM price_chunks
          WHERE document_id = ANY($2)
          ORDER BY embedding <=> $1::vector LIMIT ${RANK_DEPTH}`,
        [toVectorLiteral(vectors[qi]!), documentIds],
      );
      const score = new Map<string, { documentId: number; pageNo: number; s: number }>();
      const fuse = (ranked: { documentId: number; pageNo: number }[]) => {
        const seen = new Set<string>();
        let rank = 0;
        for (const r of ranked) {
          const key = pageKey(r.documentId, r.pageNo);
          if (seen.has(key)) continue; // a page counts once per ranking (its best chunk)
          seen.add(key);
          const cur = score.get(key) ?? { documentId: r.documentId, pageNo: r.pageNo, s: 0 };
          cur.s += 1 / (RRF_K + rank++);
          score.set(key, cur);
        }
      };
      fuse(rows.map((r) => ({ documentId: r.document_id, pageNo: r.page_no })));
      fuse(lex(queries[qi]!));
      perQuery.push([...score.values()].sort((a, b) => b.s - a.s).map(({ documentId, pageNo }) => ({ documentId, pageNo })));
    }
    await client.query('COMMIT');
    return perQuery;
  } finally {
    client.release();
  }
}

/**
 * The catalogue's own sections: consecutive pages that open with the same
 * heading line (e.g. a product range spread over several pages). A page whose
 * first line is an OCR mark or too short to be a heading stands alone.
 */
export interface Section {
  key: string;
  documentId: number;
  pages: { pageNo: number; chars: number }[];
  chars: number;
}
const sectionCache = new Map<number, { stamp: string; byPage: Map<number, Section> }>();

export async function catalogueSections(documentIds: number[]): Promise<Map<string, Section>> {
  const db = await vectorDb();
  const { rows: stamps } = await db.query<{ document_id: number; indexed_at: Date }>(
    'SELECT document_id, indexed_at FROM price_documents WHERE document_id = ANY($1)',
    [documentIds],
  );
  const byPage = new Map<string, Section>();
  for (const s of stamps) {
    const stamp = s.indexed_at.toISOString();
    let hit = sectionCache.get(s.document_id);
    if (!hit || hit.stamp !== stamp) {
      const { rows } = await db.query<{ page_no: number; heading: string; chars: number }>(
        `SELECT page_no, split_part(content, E'\\n', 1) AS heading, length(content) AS chars
           FROM price_pages WHERE document_id = $1 ORDER BY page_no`,
        [s.document_id],
      );
      const map = new Map<number, Section>();
      let cur: Section | null = null;
      let curHeading = '';
      let lastPage = -1;
      for (const r of rows) {
        const heading = r.heading.trim().toLowerCase();
        const isHeading = heading.length >= 4 && !heading.startsWith('[');
        if (!cur || !isHeading || heading !== curHeading || r.page_no !== lastPage + 1) {
          cur = { key: `${s.document_id}:s${r.page_no}`, documentId: s.document_id, pages: [], chars: 0 };
          curHeading = isHeading ? heading : '';
        }
        cur.pages.push({ pageNo: r.page_no, chars: r.chars });
        cur.chars += r.chars;
        map.set(r.page_no, cur);
        lastPage = r.page_no;
      }
      hit = { stamp, byPage: map };
      sectionCache.set(s.document_id, hit);
    }
    for (const [pageNo, sec] of hit.byPage) byPage.set(pageKey(s.document_id, pageNo), sec);
  }
  return byPage;
}

/**
 * The pages to send for these queries, within a character budget. A query's hit
 * brings its whole catalogue section (a product table and its continuation
 * pages arrive together). Coverage first: every BOQ line's best section, then
 * every rule line's best section, then every BOQ line's second section, …
 * Returned in catalogue order.
 */
export async function retrievePages(opts: RetrieveOptions): Promise<{ pages: RetrievedPage[]; added: number }> {
  const clean = (list: string[] | undefined) => [...new Set((list ?? []).map((q) => q.trim()).filter(Boolean))];
  const boqQueries = clean(opts.queries);
  const ruleQueries = clean(opts.ruleQueries).filter((q) => !boqQueries.includes(q));
  const ranked = await rankPagesPerQuery(opts.documentIds, [...boqQueries, ...ruleQueries]);
  const sectionOf = await catalogueSections(opts.documentIds);
  const depth = opts.depth ?? 2;

  // Each query's sections, best first (a section ranks by its best page).
  const sectionRanks = ranked.map((pages) => {
    const out: Section[] = [];
    const seen = new Set<string>();
    for (const p of pages) {
      const sec = sectionOf.get(pageKey(p.documentId, p.pageNo));
      if (!sec || seen.has(sec.key)) continue;
      seen.add(sec.key);
      out.push(sec);
    }
    return out;
  });
  const boqRanks = sectionRanks.slice(0, boqQueries.length);
  const ruleRanks = sectionRanks.slice(boqQueries.length);

  const chosenPages = new Map<string, { documentId: number; pageNo: number }>();
  for (const p of opts.alreadyChosen ?? []) chosenPages.set(pageKey(p.documentId, p.pageNo), p);
  const chosenSections = new Set<string>();
  let used = 0;
  const alreadyKeys = new Set(chosenPages.keys());
  // Budget counts the pages already chosen too.
  for (const key of alreadyKeys) {
    const sec = sectionOf.get(key);
    const page = sec?.pages.find((p) => pageKey(sec.documentId, p.pageNo) === key);
    used += page?.chars ?? 0;
  }
  const take = (sec: Section | undefined, limit = opts.budgetChars) => {
    if (!sec || chosenSections.has(sec.key)) return;
    const newPages = sec.pages.filter((p) => !chosenPages.has(pageKey(sec.documentId, p.pageNo)));
    const cost = newPages.reduce((s, p) => s + p.chars, 0);
    if (used + cost > limit) return; // a smaller section later may still fit
    chosenSections.add(sec.key);
    used += cost;
    for (const p of newPages) chosenPages.set(pageKey(sec.documentId, p.pageNo), { documentId: sec.documentId, pageNo: p.pageNo });
  };
  // Votes: each query gives its 1st section 1, its 2nd ½, … (rule lines count half).
  // Sections many lines point at come first; a line's own best section still
  // gets its vote, so a one-off item is not crowded out by a generic paragraph.
  const votes = new Map<string, { sec: Section; v: number }>();
  const vote = (ranks: Section[][], weight: number) => {
    for (const r of ranks) {
      r.slice(0, depth).forEach((sec, i) => {
        const cur = votes.get(sec.key) ?? { sec, v: 0 };
        cur.v += weight / (i + 1);
        votes.set(sec.key, cur);
      });
    }
  };
  vote(boqRanks, 1);
  vote(ruleRanks, 0.5);
  for (const sec of opts.include ?? []) take(sec, Math.max(opts.budgetChars, opts.maxChars ?? 0));
  const ordered = [...votes.values()].sort((a, b) => b.v - a.v);
  const voteOf = (sec: Section) => votes.get(sec.key)?.v ?? 0;
  // Coverage: every BOQ line's own best section (most-voted first), then the rest by votes.
  const bestPerLine = [...new Map(boqRanks.filter((r) => r[0]).map((r) => [r[0]!.key, r[0]!])).values()];
  for (const sec of bestPerLine.sort((a, b) => voteOf(b) - voteOf(a))) take(sec);
  for (const { sec } of ordered) take(sec);
  if (process.env.VECTOR_DEBUG) {
    for (const [i, { sec, v }] of ordered.entries())
      console.log(`  #${i} ${sec.key} p${sec.pages[0]!.pageNo}-${sec.pages.at(-1)!.pageNo} votes ${v.toFixed(2)} chars ${sec.chars}${chosenSections.has(sec.key) ? ' ✓' : ''}`);
  }

  const want = [...chosenPages.values()].sort((a, b) => a.documentId - b.documentId || a.pageNo - b.pageNo);
  if (!want.length) return { pages: [], added: 0 };
  const db = await vectorDb();
  const { rows } = await db.query<{ document_id: number; page_no: number; content: string }>(
    `SELECT p.document_id, p.page_no, p.content FROM price_pages p
       JOIN unnest($1::int[], $2::int[]) AS w(d, n) ON p.document_id = w.d AND p.page_no = w.n
      ORDER BY p.document_id, p.page_no`,
    [want.map((w) => w.documentId), want.map((w) => w.pageNo)],
  );
  const pages = rows.map((r) => ({ documentId: r.document_id, pageNo: r.page_no, content: r.content }));
  const added = pages.filter((p) => !alreadyKeys.has(pageKey(p.documentId, p.pageNo))).length;
  return { pages, added };
}

/**
 * The OUTLINE of the price lists: one line per catalogue section — an id, the
 * file, its pages, its heading and the opening text — built from the files
 * themselves. Claude reads it to name the sections a quote needs.
 */
export async function catalogueOutline(documentIds: number[]): Promise<{ text: string; byId: Map<string, Section> }> {
  const db = await vectorDb();
  const sections = await catalogueSections(documentIds);
  const { rows: docs } = await db.query<{ document_id: number; brand: string; name: string }>(
    'SELECT document_id, brand, name FROM price_documents WHERE document_id = ANY($1) ORDER BY document_id',
    [documentIds],
  );
  const { rows: firstPages } = await db.query<{ document_id: number; page_no: number; content: string }>(
    'SELECT document_id, page_no, left(content, 600) AS content FROM price_pages WHERE document_id = ANY($1)',
    [documentIds],
  );
  const opening = new Map(firstPages.map((r) => [pageKey(r.document_id, r.page_no), r.content]));
  const unique = [...new Map([...sections.values()].map((s) => [s.key, s])).values()].sort(
    (a, b) => a.documentId - b.documentId || a.pages[0]!.pageNo - b.pages[0]!.pageNo,
  );
  const byId = new Map<string, Section>();
  const lines: string[] = [];
  for (const d of docs) {
    lines.push(`FILE "${d.name}" (brand ${d.brand}):`);
    for (const sec of unique.filter((s) => s.documentId === d.document_id)) {
      const id = `S${byId.size + 1}`;
      byId.set(id, sec);
      const first = sec.pages[0]!.pageNo;
      const last = sec.pages.at(-1)!.pageNo;
      const text = (opening.get(pageKey(sec.documentId, first)) ?? '')
        .split('\n')
        .map((l) => l.trim())
        .filter((l) => l && !/^\[(ocr|image text)\]$/.test(l))
        .join(' / ')
        .replace(/\s+/g, ' ');
      lines.push(`${id} | p${first === last ? first : `${first}-${last}`} | ${text.slice(0, 220)}`);
    }
  }
  return { text: lines.join('\n'), byId };
}

/** Pages that print any of the given catalogue numbers (chat: the current BOM's pages). */
export async function pagesWithCodes(documentIds: number[], codes: string[]): Promise<{ documentId: number; pageNo: number }[]> {
  const list = [...new Set(codes.map((c) => c.trim()).filter((c) => c.length >= 4))];
  if (!list.length) return [];
  const db = await vectorDb();
  const { rows } = await db.query<{ document_id: number; page_no: number }>(
    `SELECT DISTINCT p.document_id, p.page_no FROM price_pages p
      WHERE p.document_id = ANY($1)
        AND EXISTS (SELECT 1 FROM unnest($2::text[]) AS c(code) WHERE strpos(lower(p.content), lower(c.code)) > 0)
      ORDER BY p.document_id, p.page_no`,
    [documentIds, list],
  );
  return rows.map((r) => ({ documentId: r.document_id, pageNo: r.page_no }));
}

/** BOQ / rule text → search lines (spreadsheet rows, paragraphs), in their order. */
export function queryLines(text: string, maxLines = 200): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of text.split(/\r?\n/)) {
    if (/^(=====|# )/.test(raw.trim())) continue; // file / sheet headers from the reader
    const line = raw
      .replace(/"/g, ' ')
      .replace(/^[\s,]*(?:[\w.()-]{1,8}\s*,)?/, '') // leading item-number cell
      .replace(/,+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 400);
    if (line.length < 6 || !/[a-z]/i.test(line)) continue;
    const key = line.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(line);
    if (out.length >= maxLines) break;
  }
  return out;
}
