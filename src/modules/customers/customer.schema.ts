import { z } from 'zod';

const statusEnum = z.enum(['ACTIVE', 'INACTIVE']);

export const createCustomerSchema = z.object({
  name: z.string().trim().min(1, 'Customer name is required').max(190),
  status: statusEnum.default('ACTIVE'),
  email: z.string().trim().email().max(190).optional().nullable().or(z.literal('')),
  phone: z.string().trim().max(40).optional().nullable(),
  address: z.string().trim().max(5000).optional().nullable(),
});

export const updateCustomerSchema = createCustomerSchema.partial();

export const listCustomersSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(10),
  search: z.string().trim().max(190).optional(),
  status: statusEnum.optional(),
});

export const idParamSchema = z.object({ id: z.coerce.number().int().positive() });

export type CreateCustomerInput = z.infer<typeof createCustomerSchema>;
export type UpdateCustomerInput = z.infer<typeof updateCustomerSchema>;
export type ListCustomersQuery = z.infer<typeof listCustomersSchema>;
