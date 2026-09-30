import type { Prisma } from '@prisma/client';
import { prisma } from '../../lib/prisma';
import { HttpError } from '../../lib/http-error';
import { PERMISSION_GROUPS, withImpliedViews } from '../../lib/permissions';
import type { CreateRoleInput, ListRolesQuery, UpdateRoleInput } from './role.schema';

/** The permission catalogue, for building the role editor UI. */
export function getPermissionCatalogue() {
  return PERMISSION_GROUPS;
}

export async function listRoles(query: ListRolesQuery) {
  const where: Prisma.RoleWhereInput = query.search
    ? { name: { contains: query.search } }
    : {};

  const [rows, total] = await Promise.all([
    prisma.role.findMany({
      where,
      include: { _count: { select: { users: true } } },
      orderBy: { name: 'asc' },
      skip: (query.page - 1) * query.limit,
      take: query.limit,
    }),
    prisma.role.count({ where }),
  ]);

  return {
    data: rows,
    meta: {
      page: query.page,
      limit: query.limit,
      total,
      totalPages: Math.max(1, Math.ceil(total / query.limit)),
    },
  };
}

export function getRole(id: number) {
  return prisma.role.findUniqueOrThrow({
    where: { id },
    include: { _count: { select: { users: true } } },
  });
}

export function createRole(input: CreateRoleInput) {
  return prisma.role.create({
    data: {
      name: input.name,
      description: input.description ?? null,
      permissions: withImpliedViews(input.permissions),
    },
  });
}

export async function updateRole(id: number, input: UpdateRoleInput) {
  return prisma.role.update({
    where: { id },
    data: {
      ...(input.name !== undefined ? { name: input.name } : {}),
      ...(input.description !== undefined ? { description: input.description } : {}),
      ...(input.permissions !== undefined
        ? { permissions: withImpliedViews(input.permissions) }
        : {}),
    },
  });
}

export async function deleteRole(id: number) {
  const role = await prisma.role.findUnique({
    where: { id },
    include: { _count: { select: { users: true } } },
  });
  if (!role) throw HttpError.notFound('Role not found');
  if (role.isSystem) throw HttpError.badRequest('System roles cannot be deleted');
  if (role._count.users > 0) {
    throw HttpError.conflict('Reassign the users on this role before deleting it');
  }
  await prisma.role.delete({ where: { id } });
}
