import { z } from 'zod';

export const createUserSchema = z.object({
  name: z.string().trim().min(2).max(120),
  email: z.string().trim().email().max(190),
  password: z.string().min(6).max(72),
  roleId: z.coerce.number().int().positive().optional().nullable(),
  isActive: z.coerce.boolean().optional(),
  /** Email the new user their login credentials (default true). */
  sendCredentials: z.coerce.boolean().optional().default(true),
});

export const updateUserSchema = z.object({
  name: z.string().trim().min(2).max(120).optional(),
  // Optional password reset — omit or send empty to leave unchanged.
  password: z.string().min(6).max(72).optional().or(z.literal('')),
  roleId: z.coerce.number().int().positive().optional().nullable(),
  isActive: z.coerce.boolean().optional(),
});

export const listUsersSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(10),
  search: z.string().trim().max(190).optional(),
});

export const idParamSchema = z.object({ id: z.coerce.number().int().positive() });

export type CreateUserInput = z.infer<typeof createUserSchema>;
export type UpdateUserInput = z.infer<typeof updateUserSchema>;
export type ListUsersQuery = z.infer<typeof listUsersSchema>;
