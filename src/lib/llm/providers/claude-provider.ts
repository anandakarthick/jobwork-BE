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
      const jsonHint = opts.json
        ? '\n\nReturn ONLY a single valid JSON value. No markdown fences, no commentary.'
        : '';
      const systemText = (opts.system ?? '') + jsonHint;

      const turns = input.messages.filter((m) => m.role !== 'system');
      const firstUser = turns.findIndex((m) => m.role === 'user');
      const messages: Anthropic.Beta.Messages.BetaMessageParam[] = turns.map((m, i) => {
        if (i !== firstUser) return { role: m.role as 'user' | 'assistant', content: m.content };
        // Files + the first user text. Cache breakpoint on the last file so the
        // whole file prefix is cached (max 4 breakpoints: system + here is enough).
        const files: Anthropic.Beta.Messages.BetaContentBlockParam[] = input.fileIds.map((id, k) => ({
          type: 'document' as const,
          source: { type: 'file' as const, file_id: id },
          ...(k === input.fileIds.length - 1 ? { cache_control: { type: 'ephemeral' as const } } : {}),
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
        ? [{ type: 'text' as const, text: systemText, cache_control: { type: 'ephemeral' as const } }]
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
        const stream = client().beta.messages.stream(
          {
            betas: [FILES_BETA, 'context-1m-2025-08-07'],
            model: cfg.anthropicModel,
            max_tokens: SEGMENT_MAX_TOKENS,
            ...(system ? { system } : {}),
            messages: turns,
          },
          { timeout: 30 * 60 * 1000 },
        );
        const resp = await stream.finalMessage();

        await recordUsage({
          provider: 'claude',
          model: cfg.anthropicModel,
          inputTokens:
            (resp.usage?.input_tokens ?? 0) +
            (resp.usage?.cache_read_input_tokens ?? 0) +
            (resp.usage?.cache_creation_input_tokens ?? 0),
          outputTokens: resp.usage?.output_tokens ?? 0,
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
