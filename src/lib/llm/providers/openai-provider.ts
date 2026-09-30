import OpenAI from 'openai';
import type {
  AnalyzeInput,
  AnalyzeResult,
  CompleteOptions,
  LlmContentPart,
  LlmMessage,
  LlmProvider,
} from '../types';
import { LlmNotConfiguredError } from '../types';
import type { LlmConfig } from '../settings';
import { recordUsage } from '../usage';

/**
 * Fixed seed + zero temperature make the quote pipeline reproducible: the same
 * BOQ produces the same extraction and the same catalog matches on every run,
 * instead of quantities and accessory picks drifting between generations.
 */
const QUOTE_SEED = 7;

/** Reasoning models (o-series, gpt-5) reject `temperature`/`top_p`/`seed`. */
function supportsDeterministicSampling(model: string): boolean {
  return !/^(o\d|gpt-5)/i.test(model);
}

/**
 * OpenAI (ChatGPT) provider, bound to runtime config (DB → env).
 * Mirrors the Claude provider's contract so the quote pipeline is unaware of
 * which vendor is active.
 */
export function createOpenAiProvider(cfg: LlmConfig): LlmProvider {
  function client() {
    return new OpenAI({ apiKey: cfg.openaiApiKey });
  }

  const provider: LlmProvider = {
    name: 'openai',

    isConfigured() {
      return Boolean(cfg.openaiApiKey);
    },

    async complete(messages: LlmMessage[], opts: CompleteOptions = {}): Promise<string> {
      if (!this.isConfigured()) throw new LlmNotConfiguredError(this.name);

      const jsonHint = opts.json
        ? '\n\nReturn ONLY a single valid JSON value. No markdown fences, no commentary.'
        : '';
      const systemText = (opts.system ?? '') + jsonHint;

      const chatMessages: OpenAI.Chat.ChatCompletionMessageParam[] = [
        ...(systemText.trim() ? [{ role: 'system' as const, content: systemText }] : []),
        ...messages.map((m) => ({ role: m.role, content: m.content })),
      ];

      // Deterministic sampling so the same input yields the same quote each run.
      const deterministic = supportsDeterministicSampling(cfg.openaiModel)
        ? { temperature: 0, top_p: 1, seed: QUOTE_SEED }
        : {};

      const resp = await client().chat.completions.create({
        model: cfg.openaiModel,
        max_tokens: opts.maxTokens ?? 8000,
        ...deterministic,
        ...(opts.json ? { response_format: { type: 'json_object' as const } } : {}),
        messages: chatMessages,
      });

      await recordUsage({
        provider: 'openai',
        model: cfg.openaiModel,
        inputTokens: resp.usage?.prompt_tokens ?? 0,
        outputTokens: resp.usage?.completion_tokens ?? 0,
        feature: opts.label,
      });

      return resp.choices[0]?.message?.content ?? '';
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

      const content: OpenAI.Chat.ChatCompletionContentPart[] = parts.map((p) => {
        if (p.type === 'text') return { type: 'text' as const, text: p.text ?? '' };
        if (p.type === 'image')
          return {
            type: 'image_url' as const,
            image_url: { url: `data:${p.mimeType};base64,${p.dataBase64}` },
          };
        // PDF as a file input — the model gets each page's text AND its image, so
        // scans are readable. Keep these small (a page or a few): the request is
        // capped at 100 pages / 32 MB and the reply at the model's output limit.
        return {
          type: 'file' as const,
          file: {
            filename: 'document.pdf',
            file_data: `data:application/pdf;base64,${p.dataBase64}`,
          },
        };
      });

      const resp = await client().chat.completions.create({
        model: cfg.openaiModel,
        max_tokens: opts.maxTokens ?? 8000,
        ...(opts.json ? { response_format: { type: 'json_object' as const } } : {}),
        messages: [
          ...(systemText.trim() ? [{ role: 'system' as const, content: systemText }] : []),
          { role: 'user' as const, content },
        ],
      });

      await recordUsage({
        provider: 'openai',
        model: cfg.openaiModel,
        inputTokens: resp.usage?.prompt_tokens ?? 0,
        outputTokens: resp.usage?.completion_tokens ?? 0,
        feature: opts.label,
      });

      return resp.choices[0]?.message?.content ?? '';
    },

    async analyze(input: AnalyzeInput): Promise<AnalyzeResult> {
      if (!this.isConfigured()) throw new LlmNotConfiguredError(this.name);
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
