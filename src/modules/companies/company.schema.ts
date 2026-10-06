import { z } from 'zod';

const statusEnum = z.enum(['ACTIVE', 'INACTIVE']);

export const createCompanySchema = z.object({
  name: z.string().trim().min(1).max(190),
  status: statusEnum.default('ACTIVE'),
  email: z.string().trim().email().max(190).optional().nullable().or(z.literal('')),
  phone: z.string().trim().max(40).optional().nullable(),
  address: z.string().trim().max(5000).optional().nullable(),
  // No length cap — stored as LONGTEXT.
  description: z.string().trim().optional().nullable(),
});

export const updateCompanySchema = createCompanySchema.partial();

/** Dedicated body for the quick Activate/Deactivate action. */
export const statusBodySchema = z.object({ status: statusEnum });

export const listCompaniesSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(10),
  search: z.string().trim().max(190).optional(),
  status: statusEnum.optional(),
});

export const idParamSchema = z.object({ id: z.coerce.number().int().positive() });

/** `?brands=LK,ABB` — comma-separated brand names. */
export const brandsQuerySchema = z.object({ brands: z.string().trim().max(2000).default('') });

export const priceListDocParamsSchema = z.object({
  id: z.coerce.number().int().positive(),
  docId: z.coerce.number().int().positive(),
});

export const promptParamsSchema = z.object({
  id: z.coerce.number().int().positive(),
  promptId: z.coerce.number().int().positive(),
});

/** Body for renaming a brand file and/or switching its training on/off. */
export const updatePriceListSchema = z.object({
  name: z.string().trim().max(150).optional(),
  train: z.boolean().optional(),
});

/** A multipart text field holding a JSON array (one entry per uploaded file, in order). */
function parseJsonArray(raw: unknown): unknown[] {
  if (typeof raw !== 'string') return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/** The upload's `train` field, e.g. "[true,false]". Missing/invalid → none. */
export function parseTrainFlags(raw: unknown): boolean[] {
  return parseJsonArray(raw).map((v) => v === true);
}

/** The upload's `names` field, e.g. '["Price list 1","Price list 2"]'. */
export function parseFileNames(raw: unknown): string[] {
  return parseJsonArray(raw).map((v) => (typeof v === 'string' ? v.trim().slice(0, 150) : ''));
}

/**
 * The brand's full list of keyword prompts, as the form holds it. Rows with an
 * `id` are existing prompts (updated if changed); rows without are new; existing
 * prompts left out of the list are deleted.
 */
export const savePromptsSchema = z.object({
  prompts: z
    .array(
      z.object({
        id: z.number().int().positive().optional(),
        name: z.string().trim().max(150).default(''),
        /** Group label (e.g. "MCCB"); "" = ungrouped. */
        group: z.string().trim().max(100).default(''),
        // No length cap — stored as LONGTEXT.
        content: z.string().trim().min(1, 'A prompt cannot be empty'),
        train: z.boolean(),
      }),
    )
    .max(100),
});

export type SavePromptsInput = z.infer<typeof savePromptsSchema>;
export type UpdatePriceListInput = z.infer<typeof updatePriceListSchema>;
export type CreateCompanyInput = z.infer<typeof createCompanySchema>;
export type UpdateCompanyInput = z.infer<typeof updateCompanySchema>;
export type ListCompaniesQuery = z.infer<typeof listCompaniesSchema>;
