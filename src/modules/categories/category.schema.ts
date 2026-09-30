import { z } from 'zod';

export const createCategorySchema = z.object({
  name: z.string().min(1).max(190),
  brands: z
    .array(z.string().trim().min(1).max(190))
    .min(1, 'Select at least one brand')
    .transform((arr) => Array.from(new Set(arr))), // de-dupe
  description: z.string().max(5000).optional().nullable(),
  // Linked company ids (many-to-many); optional, defaults to none.
  companyIds: z
    .array(z.coerce.number().int().positive())
    .optional()
    .default([])
    .transform((arr) => Array.from(new Set(arr))),
});

export const updateCategorySchema = createCategorySchema.partial();

export const listCategoriesSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(10),
  search: z.string().trim().max(190).optional(),
  brand: z.string().trim().max(80).optional(), // filter: categories supporting this brand
});

export const idParamSchema = z.object({ id: z.coerce.number().int().positive() });

export type CreateCategoryInput = z.infer<typeof createCategorySchema>;
export type UpdateCategoryInput = z.infer<typeof updateCategorySchema>;
export type ListCategoriesQuery = z.infer<typeof listCategoriesSchema>;
