import { stubProvider } from './stub-provider';
import { createOpenAiProvider } from './providers/openai-provider';
import { createClaudeProvider } from './providers/claude-provider';
import { getEffectiveLlmConfig } from './settings';
import type { LlmProvider } from './types';

export * from './types';
export { getEffectiveLlmConfig } from './settings';
export type { LlmConfig } from './settings';

/**
 * Resolve the active LLM provider from the effective config (DB → env).
 * Falls back to the stub when the selected provider isn't configured, so the
 * app keeps working until an API key is added.
 */
export async function getLlmProvider(): Promise<LlmProvider> {
  const cfg = await getEffectiveLlmConfig();
  let provider: LlmProvider;
  if (cfg.provider === 'openai') provider = createOpenAiProvider(cfg);
  else if (cfg.provider === 'claude') provider = createClaudeProvider(cfg);
  else provider = stubProvider;
  return provider.isConfigured() ? provider : stubProvider;
}
