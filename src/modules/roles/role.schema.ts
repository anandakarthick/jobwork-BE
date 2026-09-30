import { z } from 'zod';
import { isValidPermission } from '../../lib/permissions';

const permissionsField = z
  .array(z.string())
  .transform((arr) => Array.from(new Set(arr)))
  .refine((arr) => arr.every(isValidPermission), {
    message: 'Contains an unknown permission key',
  });

export const createRoleSchema = z.object({
  name: z.string().trim().min(1).max(80),
  description: z.string().trim().max(255).optional().nullable(),
  permissions: permissionsField,
});

export const updateRoleSchema = z.object({
  name: z.string().trim().min(1).max(80).optional(),
  description: z.string().trim().max(255).optional().nullable(),
  permissions: permissionsField.optional(),
});

export const listRolesSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  search: z.string().trim().max(80).optional(),
});

export const idParamSchema = z.object({ id: z.coerce.number().int().positive() });

export type CreateRoleInput = z.infer<typeof createRoleSchema>;
export type UpdateRoleInput = z.infer<typeof updateRoleSchema>;
export type ListRolesQuery = z.infer<typeof listRolesSchema>;
