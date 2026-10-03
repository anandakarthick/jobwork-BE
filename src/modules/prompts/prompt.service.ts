/**
 * Editable AI prompts. The system_prompts table is the source of truth; the code
 * only seeds a default per key the first time it is read (and on "reset"). The
 * pipeline reads prompts through getPromptText(), so a change made in Settings →
 * AI prompts applies to the very next quote — no restart, no code change.
 */
import { prisma } from '../../lib/prisma';
import { HttpError } from '../../lib/http-error';
import { PROMPT_DEFAULTS, PROMPT_KEYS, type PromptKey } from './prompt.defaults';

/** Short cache so a quote run (several calls) doesn't hit the DB per prompt. */
const CACHE_MS = 15_000;
const cache = new Map<string, { content: string; at: number }>();

function isKey(key: string): key is PromptKey {
  return (PROMPT_KEYS as string[]).includes(key);
}

/** Insert the seed row for a key if the table has none yet. */
async function ensureRow(key: PromptKey) {
  const existing = await prisma.systemPrompt.findUnique({ where: { key } });
  if (existing) return existing;
  const d = PROMPT_DEFAULTS[key];
  return prisma.systemPrompt.create({
    data: { key, name: d.name, description: d.description, content: d.content },
  });
}

/** The prompt text to send — from the table (seeded from the default if missing). */
export async function getPromptText(key: PromptKey): Promise<string> {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.content;
  const row = await ensureRow(key);
  cache.set(key, { content: row.content, at: Date.now() });
  return row.content;
}

/** All prompts for the settings page, each flagged if it still equals the default. */
export async function listPrompts() {
  const rows = await Promise.all(PROMPT_KEYS.map((k) => ensureRow(k)));
  return rows.map((r) => ({
    key: r.key,
    name: r.name,
    description: r.description,
    content: r.content,
    updatedAt: r.updatedAt,
    isDefault: r.content === PROMPT_DEFAULTS[r.key as PromptKey].content,
  }));
}

export async function updatePrompt(key: string, content: string) {
  if (!isKey(key)) throw HttpError.notFound('Unknown prompt');
  if (!content.trim()) throw HttpError.badRequest('The prompt cannot be empty');
  await ensureRow(key);
  const row = await prisma.systemPrompt.update({ where: { key }, data: { content } });
  cache.delete(key);
  return { ...row, isDefault: row.content === PROMPT_DEFAULTS[key].content };
}

export async function resetPrompt(key: string) {
  if (!isKey(key)) throw HttpError.notFound('Unknown prompt');
  const d = PROMPT_DEFAULTS[key];
  await ensureRow(key);
  const row = await prisma.systemPrompt.update({
    where: { key },
    data: { name: d.name, description: d.description, content: d.content },
  });
  cache.delete(key);
  return { ...row, isDefault: true };
}
