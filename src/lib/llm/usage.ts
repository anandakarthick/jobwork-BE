/**
 * LLM usage metering. Each provider call reports its token usage here; we
 * convert tokens to a USD cost with a per-model price table and store a row.
 * Summed spend is subtracted from the admin-entered balance (providers expose
 * no live balance via the API key), so the header can show a running estimate.
 */
import { prisma } from '../prisma';

/** USD per 1,000,000 tokens: [input, output]. Extend as models are added. */
const PRICING: Record<string, [number, number]> = {
  // OpenAI
  'gpt-4o': [2.5, 10],
  'gpt-4o-mini': [0.15, 0.6],
  'gpt-4.1': [2, 8],
  'gpt-4.1-mini': [0.4, 1.6],
  'gpt-4.1-nano': [0.1, 0.4],
  'gpt-4-turbo': [10, 30],
  'gpt-3.5-turbo': [0.5, 1.5],
  // Anthropic (exact ids first: "claude-opus-5-5" must not fall to the "claude-opus-5" prefix)
  'claude-fable-5-1': [10, 50],
  'claude-opus-5-5': [4, 20],
  'claude-sonnet-5-5': [2, 10],
  'claude-haiku-5-5': [0.1, 0.5],
  'claude-opus-5': [5, 25],
  'claude-opus-4-8': [5, 25],
  'claude-opus-4-7': [5, 25],
  'claude-opus-4-6': [5, 25],
  'claude-sonnet-5': [2, 10],
  'claude-sonnet-4-6': [3, 15],
  'claude-haiku-4-5': [1, 5],
};

/** Fallback rates when the exact model isn't in the table. */
const DEFAULT_RATE: Record<string, [number, number]> = {
  openai: [2.5, 10],
  claude: [5, 25],
};

function ratesFor(provider: string, model: string): [number, number] {
  if (PRICING[model]) return PRICING[model];
  // Prefix match (e.g. "gpt-4o-2024-…" → "gpt-4o").
  const hit = Object.keys(PRICING).find((k) => model.startsWith(k));
  if (hit) return PRICING[hit]!;
  return DEFAULT_RATE[provider] ?? [0, 0];
}

/**
 * Cost in USD for a call, given its token counts. `inputTokens` is ALL input;
 * the cached part of it is priced as Anthropic bills it — read from cache at
 * 0.1× the input rate, written to the (5-minute) cache at 1.25×.
 */
export function estimateCostUsd(
  provider: string,
  model: string,
  inputTokens: number,
  outputTokens: number,
  cache: { readTokens?: number; writeTokens?: number } = {},
): number {
  const [inRate, outRate] = ratesFor(provider, model);
  const read = cache.readTokens ?? 0;
  const write = cache.writeTokens ?? 0;
  const plain = Math.max(0, inputTokens - read - write);
  return ((plain + read * 0.1 + write * 1.25) / 1_000_000) * inRate + (outputTokens / 1_000_000) * outRate;
}

/** Record one call's usage. Fire-and-forget — never break the pipeline on a log error. */
export async function recordUsage(input: {
  provider: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  /** Of inputTokens: the part read from / written to the prompt cache (priced accordingly). */
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  feature?: string;
}): Promise<void> {
  try {
    const costUsd = estimateCostUsd(input.provider, input.model, input.inputTokens, input.outputTokens, {
      readTokens: input.cacheReadTokens,
      writeTokens: input.cacheWriteTokens,
    });
    await prisma.llmUsage.create({
      data: {
        provider: input.provider,
        model: input.model,
        feature: input.feature ?? null,
        inputTokens: input.inputTokens,
        outputTokens: input.outputTokens,
        costUsd,
      },
    });
  } catch {
    // Metering must never take down a quote/chat.
  }
}

/** Total USD spent on a provider since a given instant (the balance's set time). */
export async function spentSince(provider: string, since: Date | null): Promise<number> {
  const agg = await prisma.llmUsage.aggregate({
    _sum: { costUsd: true },
    where: { provider, ...(since ? { createdAt: { gte: since } } : {}) },
  });
  return agg._sum.costUsd != null ? Number(agg._sum.costUsd) : 0;
}
