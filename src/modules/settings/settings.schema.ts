import { z } from 'zod';

export const updateLlmSchema = z.object({
  provider: z.enum(['stub', 'openai', 'claude']),
  openaiModel: z.string().trim().min(1).max(80).optional(),
  anthropicModel: z.string().trim().min(1).max(80).optional(),
  // Keys: provide a value to set; omit or leave empty to keep the current one.
  openaiApiKey: z.string().max(500).optional(),
  anthropicApiKey: z.string().max(500).optional(),
  // Explicitly clear a stored key.
  clearOpenaiKey: z.coerce.boolean().optional(),
  clearAnthropicKey: z.coerce.boolean().optional(),
  // Manually-maintained credit balances (providers don't expose these).
  openaiBalance: z.coerce.number().min(0).max(1e9).optional().nullable(),
  anthropicBalance: z.coerce.number().min(0).max(1e9).optional().nullable(),
  balanceCurrency: z.string().trim().min(1).max(8).optional(),
});

export type UpdateLlmInput = z.infer<typeof updateLlmSchema>;

export const updateAppSchema = z.object({
  appName: z.string().trim().min(1).max(120).optional(),
  // Logo as a data URL; ~4M chars ≈ 3MB image. Or clear it explicitly.
  logo: z.string().max(4_000_000).optional().nullable(),
  clearLogo: z.coerce.boolean().optional(),
  themeColor: z.string().trim().max(30).optional(),
});

export type UpdateAppInput = z.infer<typeof updateAppSchema>;

export const updateSmtpSchema = z.object({
  host: z.string().trim().max(190).optional().nullable(),
  port: z.coerce.number().int().min(1).max(65535).optional(),
  secure: z.coerce.boolean().optional(),
  username: z.string().trim().max(190).optional().nullable(),
  // Password: provide to set; omit/blank to keep; clearPassword to remove.
  password: z.string().max(500).optional(),
  clearPassword: z.coerce.boolean().optional(),
  fromName: z.string().trim().max(120).optional().nullable(),
  fromEmail: z.string().trim().max(190).optional().nullable(),
});

export type UpdateSmtpInput = z.infer<typeof updateSmtpSchema>;

export const updateLetterheadSchema = z.object({
  // HTML design (letter-pad shell). ~1MB cap is ample for an inline-styled shell.
  html: z.string().max(1_000_000).optional(),
  enabled: z.coerce.boolean().optional(),
  // Restore the built-in default design.
  resetToDefault: z.coerce.boolean().optional(),
});

export type UpdateLetterheadInput = z.infer<typeof updateLetterheadSchema>;

// ---------- Quote prompt snippets (appended to the extraction prompt) ----------
export const createQuotePromptSchema = z.object({
  name: z.string().trim().min(1).max(150),
  content: z.string().trim().min(1).max(20000),
  enabled: z.coerce.boolean().optional(),
});
export type CreateQuotePromptInput = z.infer<typeof createQuotePromptSchema>;

export const updateQuotePromptSchema = z.object({
  name: z.string().trim().min(1).max(150).optional(),
  content: z.string().trim().min(1).max(20000).optional(),
  enabled: z.coerce.boolean().optional(),
});
export type UpdateQuotePromptInput = z.infer<typeof updateQuotePromptSchema>;
