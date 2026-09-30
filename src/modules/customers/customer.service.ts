import type { Prisma } from '@prisma/client';
import { prisma } from '../../lib/prisma';
import type {
  CreateCustomerInput,
  ListCustomersQuery,
  UpdateCustomerInput,
} from './customer.schema';

const withCreator = {
  createdBy: { select: { id: true, name: true, email: true } },
} satisfies Prisma.CustomerInclude;

/** Treat empty strings from the form as "not set". */
const nullify = (v: string | null | undefined) => {
  const trimmed = v?.trim();
  return trimmed ? trimmed : null;
};

export async function listCustomers(query: ListCustomersQuery) {
  const where: Prisma.CustomerWhereInput = {
    ...(query.status ? { status: query.status } : {}),
    ...(query.search
      ? {
          OR: [
            { name: { contains: query.search } },
            { email: { contains: query.search } },
            { phone: { contains: query.search } },
          ],
        }
      : {}),
  };

  const [rows, total] = await Promise.all([
    prisma.customer.findMany({
      where,
      include: withCreator,
      orderBy: { name: 'asc' },
      skip: (query.page - 1) * query.limit,
      take: query.limit,
    }),
    prisma.customer.count({ where }),
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

export function getCustomer(id: number) {
  return prisma.customer.findUniqueOrThrow({ where: { id }, include: withCreator });
}

export function createCustomer(input: CreateCustomerInput, userId: number) {
  return prisma.customer.create({
    data: {
      name: input.name,
      status: input.status,
      email: nullify(input.email),
      phone: nullify(input.phone),
      address: nullify(input.address),
      createdById: userId,
    },
    include: withCreator,
  });
}

export function updateCustomer(id: number, input: UpdateCustomerInput) {
  return prisma.customer.update({
    where: { id },
    data: {
      ...(input.name !== undefined ? { name: input.name } : {}),
      ...(input.status !== undefined ? { status: input.status } : {}),
      ...(input.email !== undefined ? { email: nullify(input.email) } : {}),
      ...(input.phone !== undefined ? { phone: nullify(input.phone) } : {}),
      ...(input.address !== undefined ? { address: nullify(input.address) } : {}),
    },
    include: withCreator,
  });
}

export async function deleteCustomer(id: number) {
  await prisma.customer.delete({ where: { id } });
}
