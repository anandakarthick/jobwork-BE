import { env } from '../../config/env';
import { prisma } from '../prisma';

export interface LlmConfig {
  provider: 'stub' | 'openai' | 'claude';
  openaiApiKey: string;
  openaiModel: string;
  anthropicApiKey: string;
  anthropicModel: string;
  /** "database" = parsed price-list rows; "claude" = brand files read by Claude. */
  quoteEngine: 'database' | 'claude';
  /** Anthropic workspace id — required by the Files API with an org-wide key. */
  anthropicWorkspaceId: string;
  /** Cheap Claude model for small jobs (section picking, simple chat answers). */
  anthropicFastModel: string;
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
    quoteEngine: row?.quoteEngine === 'claude' ? 'claude' : 'database',
    anthropicWorkspaceId: row?.anthropicWorkspaceId?.trim() || '',
    anthropicFastModel: row?.anthropicFastModel?.trim() || 'claude-haiku-4-5-20251001',
  };
}
