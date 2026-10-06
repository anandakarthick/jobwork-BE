import Anthropic from '@anthropic-ai/sdk';
import type {
  AnalyzeInput,
  AnalyzeResult,
  CompleteOptions,
  KnowledgeInput,
  LlmContentPart,
  LlmMessage,
  LlmProvider,
} from '../types';
import { LlmNotConfiguredError } from '../types';
import type { LlmConfig } from '../settings';
import { recordUsage } from '../usage';
import { FILES_BETA, anthropicClient } from '../anthropic-files';

/**
 * Anthropic (Claude) provider, bound to runtime config (DB → env).
 *
 * Notes for the configured Opus/Sonnet 4.6+ models:
 *  - No `temperature`/`top_p` (rejected with 400) — steer via the prompt.
 *  - Thinking is left off (omitted) for these structured extraction/matching
 *    calls; they don't benefit from it and it adds latency + tokens.
 *  - The stable system prompt is sent as a cached prefix (`cache_control`).
 */
/** Seconds to wait before retry `attempt` (1-based) when the provider gives no retry-after. */
const RETRY_WAITS_S = [15, 30, 45, 60, 90];

/**
 * Run a provider call, retrying on 429 (rate limit) / 529 (overloaded) / 503.
 * Honours the `retry-after` header when present. Anything else is thrown as is.
 */
async function withRateLimitRetry<T>(call: () => Promise<T>): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await call();
    } catch (err) {
      const e = err as { status?: number; headers?: Record<string, string> | Headers; message?: string };
      const msg = String(e?.message ?? '');
      const transient =
        e?.status === 429 || e?.status === 529 || e?.status === 503 || /rate.?limit|overloaded/i.test(msg);
      if (!transient || attempt > RETRY_WAITS_S.length) throw err;
      let waitS = RETRY_WAITS_S[attempt - 1]!;
      const h = e.headers;
      const ra = h && (typeof (h as Headers).get === 'function' ? (h as Headers).get('retry-after') : (h as Record<string, string>)['retry-after']);
      if (ra && Number.isFinite(Number(ra))) waitS = Math.min(120, Math.max(waitS, Number(ra)));
      console.warn(`[claude] ${e?.status ?? 'transient'} — retrying in ${waitS}s (attempt ${attempt}/${RETRY_WAITS_S.length})`);
      await new Promise((r) => setTimeout(r, waitS * 1000));
    }
  }
}

/**
 * Only ONE large (main-model) knowledge request runs at a time per server: two
 * quotes started together would otherwise add their price-list tokens in the same
 * minute and trip the input-tokens-per-minute limit. Others wait their turn.
 */
let mainQueue: Promise<void> = Promise.resolve();
/** Option objects already holding a turn in the queue (prevents re-queueing). */
const serialisedOpts = new WeakSet<object>();
function serialised<T>(fn: () => Promise<T>): Promise<T> {
  const run = mainQueue.then(fn, fn);
  mainQueue = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

export function createClaudeProvider(cfg: LlmConfig): LlmProvider {
  function client() {
    // Carries the workspace header when configured (needed for file references).
    return anthropicClient({ apiKey: cfg.anthropicApiKey, workspaceId: cfg.anthropicWorkspaceId || undefined });
  }

  /** Map our provider-neutral messages onto Claude's user/assistant turns. */
  function toClaudeMessages(messages: LlmMessage[]) {
    return messages
      .filter((m) => m.role !== 'system')
      .map((m) => ({ role: m.role as 'user' | 'assistant', content: m.content }));
  }

  const provider: LlmProvider = {
    name: 'claude',

    isConfigured() {
      return Boolean(cfg.anthropicApiKey);
    },

    async complete(messages: LlmMessage[], opts: CompleteOptions = {}): Promise<string> {
      if (!this.isConfigured()) throw new LlmNotConfiguredError(this.name);

      // Fold any system-role messages into the system prompt.
      const systemFromMessages = messages
        .filter((m) => m.role === 'system')
        .map((m) => m.content)
        .join('\n\n');
      const systemText = [opts.system, systemFromMessages].filter(Boolean).join('\n\n');
      const jsonHint = opts.json
        ? '\n\nReturn ONLY a single valid JSON value. No markdown fences, no commentary.'
        : '';

      const resp = await client().messages.create({
        model: cfg.anthropicModel,
        max_tokens: opts.maxTokens ?? 8000,
        ...(systemText
          ? {
              system: [
                {
                  type: 'text' as const,
                  text: systemText + jsonHint,
                  cache_control: { type: 'ephemeral' as const },
                },
              ],
            }
          : {}),
        messages: toClaudeMessages(messages),
      });

      await recordUsage({
        provider: 'claude',
        model: cfg.anthropicModel,
        inputTokens: resp.usage?.input_tokens ?? 0,
        outputTokens: resp.usage?.output_tokens ?? 0,
        feature: opts.label,
      });

      return resp.content
        .filter((b): b is Anthropic.TextBlock => b.type === 'text')
        .map((b) => b.text)
        .join('');
    },

    async chat(messages: LlmMessage[]): Promise<string> {
      return this.complete(messages);
    },

    async completeParts(parts: LlmContentPart[], opts: CompleteOptions = {}): Promise<string> {
      if (!this.isConfigured()) throw new LlmNotConfiguredError(this.name);

      const jsonHint = opts.json
        ? '\n\nReturn ONLY a single valid JSON value. No markdown fences, no commentary.'
        : '';
      const systemText = (opts.system ?? '') + jsonHint;

      const content = parts.map((p) => {
        if (p.type === 'text') return { type: 'text' as const, text: p.text ?? '' };
        if (p.type === 'image')
          return {
            type: 'image' as const,
            source: {
              type: 'base64' as const,
              media_type: p.mimeType as 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif',
              data: p.dataBase64 ?? '',
            },
          };
        // PDF document — Claude reads it natively (text + scans).
        return {
          type: 'document' as const,
          source: {
            type: 'base64' as const,
            media_type: 'application/pdf' as const,
            data: p.dataBase64 ?? '',
          },
        };
      });

      const resp = await client().messages.create({
        model: cfg.anthropicModel,
        max_tokens: opts.maxTokens ?? 8000,
        ...(systemText.trim()
          ? { system: [{ type: 'text' as const, text: systemText }] }
          : {}),
        messages: [{ role: 'user' as const, content }],
      });

      await recordUsage({
        provider: 'claude',
        model: cfg.anthropicModel,
        inputTokens: resp.usage?.input_tokens ?? 0,
        outputTokens: resp.usage?.output_tokens ?? 0,
        feature: opts.label,
      });

      return resp.content
        .filter((b): b is Anthropic.TextBlock => b.type === 'text')
        .map((b) => b.text)
        .join('');
    },

    /**
     * Knowledge completion. The brand files (Anthropic Files API ids) are attached
     * as document blocks on the first user turn with a cache breakpoint, so the
     * expensive part — Claude reading the price lists — is paid once per cache
     * window (5 min) and every following request in that window reads it at 10%.
     */
    async completeWithKnowledge(input: KnowledgeInput, opts: CompleteOptions = {}): Promise<string> {
      if (!this.isConfigured()) throw new LlmNotConfiguredError(this.name);
      // Big main-model requests take turns; small fast-model calls run freely.
      if (opts.tier !== 'fast' && input.fileIds.length && !serialisedOpts.has(opts)) {
        const inner = { ...opts };
        serialisedOpts.add(inner);
        return serialised(() => this.completeWithKnowledge!(input, inner));
      }
      const jsonHint = opts.json
        ? '\n\nReturn ONLY a single valid JSON value. No markdown fences, no commentary.'
        : '';
      const systemText = (opts.system ?? '') + jsonHint;

      // Cached for an HOUR (extended TTL): the brand files are the bulk of every
      // request and price lists change rarely, so quotes made within the hour read
      // them at 10% of the price instead of paying the full read each time.
      const cache = { type: 'ephemeral' as const, ttl: '1h' as const };
      const model = opts.tier === 'fast' ? cfg.anthropicFastModel : cfg.anthropicModel;

      const turns = input.messages.filter((m) => m.role !== 'system');
      const firstUser = turns.findIndex((m) => m.role === 'user');
      const messages: Anthropic.Beta.Messages.BetaMessageParam[] = turns.map((m, i) => {
        if (i !== firstUser || input.fileIds.length === 0) {
          return { role: m.role as 'user' | 'assistant', content: m.content };
        }
        // Files + the first user text. Cache breakpoint on the last file so the
        // whole file prefix is cached (max 4 breakpoints: system + here is enough).
        const files: Anthropic.Beta.Messages.BetaContentBlockParam[] = input.fileIds.map((id, k) => ({
          type: 'document' as const,
          source: { type: 'file' as const, file_id: id },
          ...(k === input.fileIds.length - 1 ? { cache_control: cache } : {}),
        }));
        return { role: 'user' as const, content: [...files, { type: 'text' as const, text: m.content }] };
      });

      // Price lists of several brands can exceed the standard window — ask for the
      // 1M-token context (ignored by models that do not need it). A whole BOM is a
      // long answer, so the SDK requires STREAMING (non-streaming calls are capped
      // at ~10 minutes); we stream and wait for the final message.
      //
      // UNLIMITED LENGTH: a reply is produced in segments. When a segment stops at
      // the per-call output cap (stop_reason "max_tokens"), the partial text is sent
      // back as the assistant's turn and Claude continues exactly where it stopped;
      // the segments are joined. The price lists are cached, so a continuation only
      // pays for the new output.
      const SEGMENT_MAX_TOKENS = 32_000;
      const MAX_SEGMENTS = 12;
      const system = systemText.trim()
        ? [{ type: 'text' as const, text: systemText, cache_control: cache }]
        : undefined;
      let text = '';
      for (let segment = 0; segment < MAX_SEGMENTS; segment++) {
        const turns: Anthropic.Beta.Messages.BetaMessageParam[] = text
          ? [
              ...messages,
              { role: 'assistant', content: text },
              {
                role: 'user',
                content:
                  'Your previous message was cut off by the length limit. Continue EXACTLY from the last ' +
                  'character you wrote — do not repeat anything, do not add commentary, just the remaining text.',
              },
            ]
          : messages;
        // Rate limits (429) and overload (529) are transient: wait as the provider
        // asks (retry-after) or with a growing pause, and try again — up to 5 times
        // (≈ 4 minutes) before giving up. A rejected request is never billed, so
        // retrying costs nothing but time.
        const resp = await withRateLimitRetry(() =>
          client()
            .beta.messages.stream(
              {
                betas: [FILES_BETA, 'context-1m-2025-08-07', 'extended-cache-ttl-2025-04-11'],
                model,
                max_tokens: Math.min(SEGMENT_MAX_TOKENS, opts.maxTokens ?? SEGMENT_MAX_TOKENS),
                ...(system ? { system } : {}),
                messages: turns,
              },
              { timeout: 30 * 60 * 1000, maxRetries: 2 },
            )
            .finalMessage(),
        );

        // Meter at the real price: cache reads cost 10%, cache writes 125% (5 min)
        // or 200% (1 h) of the input rate — fold them into an equivalent input count.
        const u = resp.usage;
        const cacheWrite =
          (u?.cache_creation?.ephemeral_1h_input_tokens ?? 0) * 2 +
          (u?.cache_creation?.ephemeral_5m_input_tokens ?? 0) * 1.25 +
          (u?.cache_creation ? 0 : (u?.cache_creation_input_tokens ?? 0) * 2);
        await recordUsage({
          provider: 'claude',
          model,
          inputTokens: Math.round((u?.input_tokens ?? 0) + (u?.cache_read_input_tokens ?? 0) * 0.1 + cacheWrite),
          outputTokens: u?.output_tokens ?? 0,
          feature: opts.label,
        });

        text += resp.content
          .filter((b): b is Anthropic.Beta.Messages.BetaTextBlock => b.type === 'text')
          .map((b) => b.text)
          .join('');
        if (resp.stop_reason !== 'max_tokens') break;
      }
      return text;
    },

    async analyze(input: AnalyzeInput): Promise<AnalyzeResult> {
      if (!this.isConfigured()) throw new LlmNotConfiguredError(this.name);
      // Kept for the legacy jobwork flow. The quote pipeline uses `complete`.
      const system =
        'You extract part requirements from procurement documents for an electrical ' +
        'switchgear supplier. Given the catalogue, map each requirement to a category.';
      const catalogue = JSON.stringify(input.catalogue.categories);
      const user =
        `Customer: ${input.customerName}\nCatalogue categories: ${catalogue}\n` +
        `Documents: ${input.documents.map((d) => d.fileName).join(', ')}\n` +
        (input.instructions ? `Instructions: ${input.instructions}\n` : '') +
        'Return JSON: {"summary": string, "requirements": [{"partName": string, ' +
        '"quantity": number|null, "specifications": string|null, ' +
        '"matchedCategoryId": number|null, "suggestedBrands": string[], "notes": string|null}]}';
      const raw = await this.complete([{ role: 'user', content: user }], { system, json: true });
      const parsed = JSON.parse(raw) as AnalyzeResult;
      return { summary: parsed.summary ?? '', requirements: parsed.requirements ?? [] };
    },
  };

  return provider;
}
