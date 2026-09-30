import bcrypt from 'bcryptjs';
import type { Prisma } from '@prisma/client';
import { prisma } from '../../lib/prisma';
import { HttpError } from '../../lib/http-error';
import { sendUserCredentials } from '../email/email.service';
import type { CreateUserInput, ListUsersQuery, UpdateUserInput } from './user.schema';

const publicSelect = {
  id: true,
  name: true,
  email: true,
  isActive: true,
  createdAt: true,
  updatedAt: true,
  role: { select: { id: true, name: true } },
} satisfies Prisma.UserSelect;

export async function listUsers(query: ListUsersQuery) {
  const where: Prisma.UserWhereInput = query.search
    ? {
        OR: [
          { name: { contains: query.search } },
          { email: { contains: query.search } },
        ],
      }
    : {};

  const [rows, total] = await Promise.all([
    prisma.user.findMany({
      where,
      select: publicSelect,
      orderBy: { name: 'asc' },
      skip: (query.page - 1) * query.limit,
      take: query.limit,
    }),
    prisma.user.count({ where }),
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

export function getUser(id: number) {
  return prisma.user.findUniqueOrThrow({ where: { id }, select: publicSelect });
}

async function ensureRole(roleId: number) {
  const role = await prisma.role.findUnique({ where: { id: roleId }, select: { id: true } });
  if (!role) throw HttpError.badRequest('Role not found');
}

export async function createUser(input: CreateUserInput, createdById?: number) {
  const existing = await prisma.user.findUnique({ where: { email: input.email } });
  if (existing) throw HttpError.conflict('Email is already registered');
  if (input.roleId) await ensureRole(input.roleId);

  const user = await prisma.user.create({
    data: {
      name: input.name,
      email: input.email,
      password: await bcrypt.hash(input.password, 10),
      roleId: input.roleId ?? null,
      isActive: input.isActive ?? true,
    },
    select: publicSelect,
  });

  // Email the new user their credentials (best-effort — never blocks creation).
  // `input.password` is the plaintext the admin just set, before hashing.
  let credentialsEmail: { sent: boolean; error: string | null } | null = null;
  if (input.sendCredentials !== false) {
    credentialsEmail = await sendUserCredentials({
      to: user.email,
      name: user.name,
      password: input.password,
      roleName: user.role?.name ?? null,
      createdById,
    });
  }

  return { ...user, credentialsEmail };
}

export async function updateUser(id: number, input: UpdateUserInput) {
  if (input.roleId) await ensureRole(input.roleId);

  const data: Prisma.UserUpdateInput = {};
  if (input.name !== undefined) data.name = input.name;
  if (input.isActive !== undefined) data.isActive = input.isActive;
  if (input.roleId !== undefined) {
    data.role = input.roleId ? { connect: { id: input.roleId } } : { disconnect: true };
  }
  if (input.password) data.password = await bcrypt.hash(input.password, 10);

  return prisma.user.update({ where: { id }, data, select: publicSelect });
}

export async function deleteUser(id: number, currentUserId: number) {
  if (id === currentUserId) throw HttpError.badRequest('You cannot delete your own account');
  await prisma.user.delete({ where: { id } });
}
