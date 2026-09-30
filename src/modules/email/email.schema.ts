import { z } from 'zod';

export const idParamSchema = z.object({ id: z.coerce.number().int().positive() });

export const sendQuoteEmailSchema = z.object({
  quoteId: z.coerce.number().int().positive(),
  /** One or more recipients (customer + any extras the sender adds). */
  to: z.array(z.string().trim().email()).min(1, 'Add at least one recipient').max(20),
  subject: z.string().trim().min(1).max(300),
  /** Plain-text message; dropped into the letter-pad design at send time. */
  message: z.string().trim().min(1).max(20000),
  /** Attach the generated quote spreadsheet. */
  attachQuote: z.coerce.boolean().optional().default(true),
  /** Uploaded input documents (by id) to also attach. */
  documentIds: z.array(z.coerce.number().int().positive()).max(50).optional().default([]),
});

export const sendTestSchema = z.object({
  to: z.string().trim().email().optional(),
});

export const listLogsSchema = z.object({
  quoteId: z.coerce.number().int().positive().optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

export type SendQuoteEmailInput = z.infer<typeof sendQuoteEmailSchema>;
export type ListLogsQuery = z.infer<typeof listLogsSchema>;
