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
  /**
   * The brand keyword prompts (rules) picked for this chat, as a JSON array of
   * ids in the multipart form (e.g. "[3,7]"). Omitted = every trained prompt.
   */
  promptIds: z
    .string()
    .optional()
    .transform((raw, ctx) => {
      if (raw == null || raw.trim() === '') return null;
      try {
        const parsed: unknown = JSON.parse(raw);
        if (Array.isArray(parsed) && parsed.every((v) => Number.isInteger(v) && v > 0)) {
          return parsed as number[];
        }
      } catch {
        /* fall through */
      }
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'promptIds must be a JSON array of ids' });
      return z.NEVER;
    }),
});

/**
 * Change a chat's name, customer, brands or selected rules. Everything is
 * optional; only the fields sent are changed. `promptIds: []` = no rules.
 */
export const updateQuoteSchema = z
  .object({
    title: z.string().trim().min(1).max(190).optional(),
    customerId: z.number().int().positive().optional(),
    /** Comma-separated brand names, as stored on the quote. */
    brand: z.string().trim().min(1).max(80).optional(),
    promptIds: z.array(z.number().int().positive()).max(200).optional(),
  })
  .refine((v) => Object.keys(v).length > 0, { message: 'Nothing to update' });

export type UpdateQuoteInput = z.infer<typeof updateQuoteSchema>;

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
