import type {
  AnalyzeInput,
  AnalyzeResult,
  CompleteOptions,
  LlmContentPart,
  LlmMessage,
  LlmProvider,
} from './types';
import { LlmNotConfiguredError } from './types';

/**
 * Placeholder provider used until a real API key is wired up.
 *
 * It performs NO external calls — it returns a deterministic, clearly-labelled
 * response so the upload → analyze → chat flow works end-to-end during
 * development. Swap `LLM_PROVIDER=openai` / `claude` (with a key) to go live.
 */
export const stubProvider: LlmProvider = {
  name: 'stub',

  isConfigured() {
    return true;
  },

  async analyze(input: AnalyzeInput): Promise<AnalyzeResult> {
    const docList = input.documents.map((d) => `• ${d.fileName}`).join('\n') || '• (none)';
    return {
      summary:
        `⚙️ LLM not connected yet — this is a placeholder analysis.\n\n` +
        `Customer: ${input.customerName}\n` +
        `Documents received:\n${docList}\n\n` +
        `Once an OpenAI or Claude API key is configured, the extracted parts and ` +
        `matching companies will be listed here.`,
      requirements: [],
    };
  },

  async chat(messages: LlmMessage[]): Promise<string> {
    const last = [...messages].reverse().find((m) => m.role === 'user');
    return (
      `⚙️ LLM not connected yet — placeholder reply.\n\n` +
      `You said: “${last?.content ?? ''}”.\n` +
      `Connect a provider to get real answers about the job-work requirements.`
    );
  },

  // The quote pipeline needs a real model — the stub cannot fabricate matches.
  async complete(_messages: LlmMessage[], _opts?: CompleteOptions): Promise<string> {
    throw new LlmNotConfiguredError('stub');
  },

  async completeParts(_parts: LlmContentPart[], _opts?: CompleteOptions): Promise<string> {
    throw new LlmNotConfiguredError('stub');
  },
};
