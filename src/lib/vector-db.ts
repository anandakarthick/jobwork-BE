/**
 * PostgreSQL + pgvector — the price-list search index.
 *
 * The app's own data stays in MySQL (Prisma). This second database only holds
 * the brand price lists split into pages and searchable chunks, so a quote can
 * send Claude the pages that match the BOQ instead of the whole files.
 * Configured by VECTOR_DATABASE_URL; when it is unset the feature is off and
 * quotes attach the full files as before.
 */
import { Pool } from 'pg';
import { env } from '../config/env';

let pool: Pool | null = null;
let ready: Promise<void> | null = null;

export function vectorDbConfigured(): boolean {
  return Boolean(env.vectorDatabaseUrl);
}

/** Tables are created on first use (idempotent), like a tiny migration. */
const SCHEMA = `
CREATE EXTENSION IF NOT EXISTS vector;
CREATE TABLE IF NOT EXISTS price_documents (
  document_id  integer PRIMARY KEY,
  brand        text NOT NULL,
  name         text NOT NULL,
  ai_file_id   text,
  model        text NOT NULL,
  pages        integer NOT NULL DEFAULT 0,
  chunks       integer NOT NULL DEFAULT 0,
  chars        integer NOT NULL DEFAULT 0,
  indexed_at   timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS price_pages (
  document_id  integer NOT NULL REFERENCES price_documents(document_id) ON DELETE CASCADE,
  page_no      integer NOT NULL,
  content      text NOT NULL,
  PRIMARY KEY (document_id, page_no)
);
CREATE TABLE IF NOT EXISTS price_chunks (
  id           bigserial PRIMARY KEY,
  document_id  integer NOT NULL REFERENCES price_documents(document_id) ON DELETE CASCADE,
  page_no      integer NOT NULL,
  content      text NOT NULL,
  embedding    vector(768) NOT NULL
);
CREATE INDEX IF NOT EXISTS price_chunks_doc_idx ON price_chunks (document_id, page_no);
CREATE INDEX IF NOT EXISTS price_chunks_embedding_idx ON price_chunks USING hnsw (embedding vector_cosine_ops);
`;

export async function vectorDb(): Promise<Pool> {
  if (!env.vectorDatabaseUrl) throw new Error('VECTOR_DATABASE_URL is not set.');
  if (!pool) {
    pool = new Pool({ connectionString: env.vectorDatabaseUrl, max: 4 });
    pool.on('error', (err) => console.warn('[vector-db]', err.message));
  }
  if (!ready) {
    ready = pool.query(SCHEMA).then(
      () => undefined,
      (err) => {
        ready = null;
        throw err;
      },
    );
  }
  await ready;
  return pool;
}

/** pgvector literal for a float array. */
export function toVectorLiteral(v: number[]): string {
  return `[${v.join(',')}]`;
}
