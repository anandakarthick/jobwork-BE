import type { Prisma } from '@prisma/client';
import { prisma } from '../../lib/prisma';
import { spentSince } from '../../lib/llm/usage';
import { DEFAULT_LETTERHEAD, LETTERHEAD_PRESETS } from '../email/letterhead';
import type {
  UpdateAppInput,
  UpdateLetterheadInput,
  UpdateLlmInput,
  UpdateSmtpInput,
} from './settings.schema';

/** Letter-pad (letterhead) design — the branded shell wrapping outgoing email. */
export async function getLetterhead() {
  const row = await prisma.letterhead.findUnique({ where: { id: 1 } });
  return {
    // Fall back to the built-in design so the editor always shows something.
    html: row?.html ?? DEFAULT_LETTERHEAD,
    enabled: row?.enabled ?? true,
    isDefault: !row?.html,
    updatedAt: row?.updatedAt ?? null,
  };
}

/** The selectable sample letter-pad formats (built-in designs). */
export function getLetterheadPresets() {
  return LETTERHEAD_PRESETS;
}

export async function updateLetterhead(input: UpdateLetterheadInput) {
  const update: Prisma.LetterheadUpdateInput = {};
  if (input.enabled !== undefined) update.enabled = input.enabled;
  if (input.resetToDefault) update.html = null;
  else if (input.html !== undefined) update.html = input.html;

  await prisma.letterhead.upsert({
    where: { id: 1 },
    update,
    create: {
      id: 1,
      html: input.resetToDefault ? null : input.html ?? null,
      enabled: input.enabled ?? true,
    },
  });
  return getLetterhead();
}

/** SMTP/email config — password is never returned (only whether it's set). */
export async function getSmtpSettings() {
  const row = await prisma.smtpSetting.findUnique({ where: { id: 1 } });
  return {
    host: row?.host ?? '',
    port: row?.port ?? 587,
    secure: row?.secure ?? false,
    username: row?.username ?? '',
    passwordSet: Boolean(row?.password),
    fromName: row?.fromName ?? '',
    fromEmail: row?.fromEmail ?? '',
    updatedAt: row?.updatedAt ?? null,
  };
}

export async function updateSmtpSettings(input: UpdateSmtpInput) {
  const update: Prisma.SmtpSettingUpdateInput = {};
  if (input.host !== undefined) update.host = input.host;
  if (input.port !== undefined) update.port = input.port;
  if (input.secure !== undefined) update.secure = input.secure;
  if (input.username !== undefined) update.username = input.username;
  if (input.fromName !== undefined) update.fromName = input.fromName;
  if (input.fromEmail !== undefined) update.fromEmail = input.fromEmail;
  if (input.clearPassword) update.password = null;
  else if (input.password) update.password = input.password;

  await prisma.smtpSetting.upsert({
    where: { id: 1 },
    update,
    create: {
      id: 1,
      host: input.host ?? null,
      port: input.port ?? 587,
      secure: input.secure ?? false,
      username: input.username ?? null,
      password: input.clearPassword ? null : input.password || null,
      fromName: input.fromName ?? null,
      fromEmail: input.fromEmail ?? null,
    },
  });
  return getSmtpSettings();
}

/** App branding (project name + logo) — used across the app and login page. */
export async function getAppSettings() {
  const row = await prisma.appSetting.findUnique({ where: { id: 1 } });
  return {
    appName: row?.appName ?? 'Jobwork',
    logo: row?.logo ?? null,
    themeColor: row?.themeColor ?? 'indigo',
    updatedAt: row?.updatedAt ?? null,
  };
}

export async function updateAppSettings(input: UpdateAppInput) {
  const update: Prisma.AppSettingUpdateInput = {};
  if (input.appName !== undefined) update.appName = input.appName;
  if (input.themeColor !== undefined) update.themeColor = input.themeColor;
  if (input.clearLogo) update.logo = null;
  else if (input.logo !== undefined) update.logo = input.logo;

  await prisma.appSetting.upsert({
    where: { id: 1 },
    update,
    create: {
      id: 1,
      appName: input.appName ?? 'Jobwork',
      logo: input.clearLogo ? null : input.logo ?? null,
      themeColor: input.themeColor ?? 'indigo',
    },
  });
  return getAppSettings();
}

/** Masked view — never returns the raw API keys, only whether they're set. */
export async function getLlmSettings() {
  const row = await prisma.llmSetting.findUnique({ where: { id: 1 } });
  return {
    provider: row?.provider ?? 'stub',
    openaiModel: row?.openaiModel ?? 'gpt-4o',
    anthropicModel: row?.anthropicModel ?? 'claude-opus-4-8',
    quoteEngine: (row?.quoteEngine as 'database' | 'claude' | undefined) ?? 'database',
    anthropicWorkspaceId: row?.anthropicWorkspaceId ?? '',
    anthropicFastModel: row?.anthropicFastModel ?? 'claude-haiku-4-5-20251001',
    openaiKeySet: Boolean(row?.openaiApiKey),
    anthropicKeySet: Boolean(row?.anthropicApiKey),
    openaiBalance: row?.openaiBalance != null ? Number(row.openaiBalance) : null,
    anthropicBalance: row?.anthropicBalance != null ? Number(row.anthropicBalance) : null,
    balanceCurrency: row?.balanceCurrency ?? 'USD',
    updatedAt: row?.updatedAt ?? null,
  };
}

/**
 * Lightweight status for the app header: which provider is active, its model,
 * and whether a key is set. `balance` is null because neither OpenAI nor
 * Anthropic exposes an account balance through a standard API key — surface
 * the label so the UI can say "not available" rather than imply a number.
 */
export async function getLlmStatus() {
  const s = await getLlmSettings();
  const row = await prisma.llmSetting.findUnique({ where: { id: 1 } });
  const provider = s.provider as 'stub' | 'openai' | 'claude';
  const model = provider === 'openai' ? s.openaiModel : provider === 'claude' ? s.anthropicModel : null;
  const keySet =
    provider === 'openai' ? s.openaiKeySet : provider === 'claude' ? s.anthropicKeySet : false;
  const balance =
    provider === 'openai' ? s.openaiBalance : provider === 'claude' ? s.anthropicBalance : null;
  const balanceAt =
    provider === 'openai' ? row?.openaiBalanceAt ?? null : provider === 'claude' ? row?.anthropicBalanceAt ?? null : null;

  // Estimated spend (USD) since the balance was last set, and the remainder.
  // Kept at 4 decimals so sub-cent per-call spend is still visible.
  const spent = provider === 'stub' ? 0 : round4(await spentSince(provider, balanceAt));
  const remaining = balance != null ? round4(balance - spent) : null;

  return {
    provider,
    model,
    quoteEngine: s.quoteEngine,
    keySet,
    balance,
    spent,
    remaining,
    balanceCurrency: s.balanceCurrency,
    // Balance is admin-entered; spend is an estimate (token usage × model price).
    balanceNote: 'Balance is entered manually; remaining = balance − estimated usage since it was set.',
  };
}

function round4(n: number): number {
  return Math.round(n * 10000) / 10000;
}

export async function updateLlmSettings(input: UpdateLlmInput) {
  const update: Prisma.LlmSettingUpdateInput = { provider: input.provider };
  if (input.openaiModel !== undefined) update.openaiModel = input.openaiModel;
  if (input.anthropicModel !== undefined) update.anthropicModel = input.anthropicModel;
  if (input.quoteEngine !== undefined) update.quoteEngine = input.quoteEngine;
  if (input.anthropicWorkspaceId !== undefined) update.anthropicWorkspaceId = input.anthropicWorkspaceId || null;
  if (input.anthropicFastModel !== undefined) update.anthropicFastModel = input.anthropicFastModel;
  // Setting a balance resets its "as of" instant, so spend is counted from now.
  if (input.openaiBalance !== undefined) {
    update.openaiBalance = input.openaiBalance;
    update.openaiBalanceAt = new Date();
  }
  if (input.anthropicBalance !== undefined) {
    update.anthropicBalance = input.anthropicBalance;
    update.anthropicBalanceAt = new Date();
  }
  if (input.balanceCurrency !== undefined) update.balanceCurrency = input.balanceCurrency;

  if (input.clearOpenaiKey) update.openaiApiKey = null;
  else if (input.openaiApiKey) update.openaiApiKey = input.openaiApiKey;

  if (input.clearAnthropicKey) update.anthropicApiKey = null;
  else if (input.anthropicApiKey) update.anthropicApiKey = input.anthropicApiKey;

  await prisma.llmSetting.upsert({
    where: { id: 1 },
    update,
    create: {
      id: 1,
      provider: input.provider,
      openaiModel: input.openaiModel ?? 'gpt-4o',
      anthropicModel: input.anthropicModel ?? 'claude-opus-4-8',
      quoteEngine: input.quoteEngine ?? 'database',
      anthropicWorkspaceId: input.anthropicWorkspaceId || null,
      anthropicFastModel: input.anthropicFastModel ?? 'claude-haiku-4-5-20251001',
      openaiApiKey: input.clearOpenaiKey ? null : input.openaiApiKey || null,
      anthropicApiKey: input.clearAnthropicKey ? null : input.anthropicApiKey || null,
    },
  });

  return getLlmSettings();
}

