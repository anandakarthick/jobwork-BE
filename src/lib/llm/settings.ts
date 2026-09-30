import { env } from '../../config/env';
import { prisma } from '../prisma';

export interface LlmConfig {
  provider: 'stub' | 'openai' | 'claude';
  openaiApiKey: string;
  openaiModel: string;
  anthropicApiKey: string;
  anthropicModel: string;
}

/**
 * Effective LLM config: the DB singleton row (managed by admins in Settings)
 * takes precedence, falling back to environment variables when unset. This is
 * what makes the feature flexible between OpenAI and Claude at runtime.
 */
export async function getEffectiveLlmConfig(): Promise<LlmConfig> {
  const row = await prisma.llmSetting.findUnique({ where: { id: 1 } });
  return {
    provider: (row?.provider as LlmConfig['provider']) || env.llm.provider,
    openaiApiKey: row?.openaiApiKey || env.llm.openaiApiKey,
    openaiModel: row?.openaiModel || env.llm.openaiModel,
    anthropicApiKey: row?.anthropicApiKey || env.llm.anthropicApiKey,
    anthropicModel: row?.anthropicModel || env.llm.anthropicModel,
  };
}
