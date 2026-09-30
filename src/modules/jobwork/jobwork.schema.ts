import { z } from 'zod';

// `brands` arrives from multipart as a JSON string, a repeated field (array),
// or a single string. Normalise all three to string[].
const brandsField = z
  .union([z.string(), z.array(z.string())])
  .optional()
  .transform((v): string[] => {
    if (v === undefined) return [];
    if (Array.isArray(v)) return v.map((s) => s.trim()).filter(Boolean);
    const raw = v.trim();
    if (!raw) return [];
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) return parsed.map((s) => String(s).trim()).filter(Boolean);
    } catch {
      /* not JSON — treat as a single value */
    }
    return [raw];
  });

// Multipart body fields arrive as strings, so coerce.
export const createAnalysisSchema = z.object({
  customerId: z.coerce.number().int().positive(),
  categoryId: z.coerce.number().int().positive().optional(),
  brands: brandsField,
  title: z.string().trim().max(190).optional(),
  instructions: z.string().trim().max(5000).optional(),
});

export const chatMessageSchema = z.object({
  content: z.string().trim().min(1).max(5000),
});

export const listAnalysesSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(10),
  customerId: z.coerce.number().int().positive().optional(),
});

export const idParamSchema = z.object({ id: z.coerce.number().int().positive() });

export type CreateAnalysisInput = z.infer<typeof createAnalysisSchema>;
export type ListAnalysesQuery = z.infer<typeof listAnalysesSchema>;
