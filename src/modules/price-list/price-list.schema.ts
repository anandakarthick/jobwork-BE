import { z } from 'zod';

export const docIdParamSchema = z.object({ docId: z.coerce.number().int().positive() });

export const setKindSchema = z.object({
  kind: z.enum(['PRICE_LIST', 'SPEC', 'DRAWING', 'OTHER']),
  brand: z.string().trim().min(1).max(80).optional().nullable(),
});

export const listItemsSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(200).default(25),
  search: z.string().trim().max(160).optional(),
});

/** Body for the candidate-retrieval endpoint (a single requirement line). */
export const candidatesSchema = z.object({
  poles: z.number().int().positive().optional().nullable(),
  ratingAmp: z.number().positive().optional().nullable(),
  breakingKa: z.number().positive().optional().nullable(),
  keywords: z.array(z.string().trim().min(1)).max(20).optional(),
  limit: z.number().int().min(1).max(50).optional(),
});

export type SetKindInput = z.infer<typeof setKindSchema>;
export type ListItemsQuery = z.infer<typeof listItemsSchema>;
export type CandidatesInput = z.infer<typeof candidatesSchema>;
