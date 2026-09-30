import { z } from 'zod';

export const createQuoteSchema = z.object({
  customerId: z.coerce.number().int().positive(),
  categoryId: z.coerce.number().int().positive().optional(),
  brand: z.string().trim().min(1).max(80).optional(),
  priceListDocumentId: z.coerce.number().int().positive().optional(),
  title: z.string().trim().max(190).optional(),
  /** Per-quote discount applied to every line (editable later). */
  defaultDiscountPct: z.coerce.number().min(0).max(100).optional(),
  /** The user's first chat message, sent with the BOQ — also steers extraction. */
  message: z.string().trim().max(4000).optional().default(''),
});

/** Rename a chat (quote). */
export const renameQuoteSchema = z.object({ title: z.string().trim().min(1).max(190) });

export const listQuotesSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(10),
  customerId: z.coerce.number().int().positive().optional(),
});

export const idParamSchema = z.object({ id: z.coerce.number().int().positive() });

export const chatMessageSchema = z.object({
  // Optional so a message can be attachments-only; the route requires content OR files.
  content: z.string().trim().max(4000).optional().default(''),
});

export type CreateQuoteInput = z.infer<typeof createQuoteSchema>;
export type ListQuotesQuery = z.infer<typeof listQuotesSchema>;
