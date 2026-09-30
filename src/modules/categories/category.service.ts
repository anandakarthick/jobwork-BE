import fs from 'fs/promises';
import type { Prisma } from '@prisma/client';
import { prisma } from '../../lib/prisma';
import { HttpError } from '../../lib/http-error';
import type {
  CreateCategoryInput,
  ListCategoriesQuery,
  UpdateCategoryInput,
} from './category.schema';

const withCreator = {
  createdBy: { select: { id: true, name: true, email: true } },
  companies: { select: { id: true, name: true, status: true }, orderBy: { name: 'asc' } },
  documents: {
    select: {
      id: true,
      fileName: true,
      mimeType: true,
      sizeBytes: true,
      createdAt: true,
    },
    orderBy: { id: 'asc' },
  },
} satisfies Prisma.ProductCategoryInclude;

/** Metadata for a stored upload, as produced by the multer middleware. */
export interface StoredFile {
  originalName: string;
  storedName: string;
  mimeType: string;
  sizeBytes: number;
  path: string;
}

export async function listCategories(query: ListCategoriesQuery) {
  const where: Prisma.ProductCategoryWhereInput = {
    ...(query.search ? { name: { contains: query.search } } : {}),
    // "which categories support this brand" — JSON array membership.
    ...(query.brand ? { brands: { array_contains: query.brand } } : {}),
  };

  const [rows, total] = await Promise.all([
    prisma.productCategory.findMany({
      where,
      include: {
        ...withCreator,
        _count: { select: { documents: true } },
      },
      orderBy: { name: 'asc' },
      skip: (query.page - 1) * query.limit,
      take: query.limit,
    }),
    prisma.productCategory.count({ where }),
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

export function getCategory(id: number) {
  return prisma.productCategory.findUniqueOrThrow({ where: { id }, include: withCreator });
}

export function createCategory(input: CreateCategoryInput, userId: number) {
  return prisma.productCategory.create({
    data: {
      name: input.name,
      brands: input.brands,
      description: input.description ?? null,
      createdById: userId,
      companies: { connect: input.companyIds.map((cid) => ({ id: cid })) },
    },
    include: withCreator,
  });
}

export function updateCategory(id: number, input: UpdateCategoryInput) {
  return prisma.productCategory.update({
    where: { id },
    data: {
      ...(input.name !== undefined ? { name: input.name } : {}),
      ...(input.brands !== undefined ? { brands: input.brands } : {}),
      ...(input.description !== undefined ? { description: input.description } : {}),
      // `set` replaces the whole link list with exactly these companies.
      ...(input.companyIds !== undefined
        ? { companies: { set: input.companyIds.map((cid) => ({ id: cid })) } }
        : {}),
    },
    include: withCreator,
  });
}

export async function deleteCategory(id: number) {
  // Remove the on-disk files for this category's documents, then the row
  // (which cascade-deletes the document records).
  const docs = await prisma.productDocument.findMany({
    where: { categoryId: id },
    select: { storagePath: true },
  });
  await prisma.productCategory.delete({ where: { id } });
  await Promise.all(docs.map((d) => fs.rm(d.storagePath, { force: true }).catch(() => {})));
}

// ---------- Documents ----------

const documentSelect = {
  id: true,
  fileName: true,
  mimeType: true,
  sizeBytes: true,
  createdAt: true,
  // Price-list ingestion state, so the UI can offer "mark as price list" + ingest.
  kind: true,
  brand: true,
  ingestStatus: true,
  ingestedItemCount: true,
  ingestError: true,
} satisfies Prisma.ProductDocumentSelect;

export async function listDocuments(categoryId: number) {
  await ensureCategory(categoryId);
  return prisma.productDocument.findMany({
    where: { categoryId },
    select: documentSelect,
    orderBy: { id: 'asc' },
  });
}

export async function addDocuments(categoryId: number, files: StoredFile[], userId: number) {
  await ensureCategory(categoryId);
  if (files.length === 0) throw HttpError.badRequest('No files uploaded');

  await prisma.productDocument.createMany({
    data: files.map((f) => ({
      categoryId,
      fileName: f.originalName,
      storedName: f.storedName,
      mimeType: f.mimeType,
      sizeBytes: f.sizeBytes,
      storagePath: f.path,
      createdById: userId,
    })),
  });

  return prisma.productDocument.findMany({
    where: { categoryId },
    select: documentSelect,
    orderBy: { id: 'asc' },
  });
}

/** Returns the full row (incl. storagePath) for streaming a download. */
export async function getDocumentForDownload(categoryId: number, docId: number) {
  const doc = await prisma.productDocument.findFirst({ where: { id: docId, categoryId } });
  if (!doc) throw HttpError.notFound('Document not found');
  return doc;
}

export async function deleteDocument(categoryId: number, docId: number) {
  const doc = await prisma.productDocument.findFirst({ where: { id: docId, categoryId } });
  if (!doc) throw HttpError.notFound('Document not found');
  await prisma.productDocument.delete({ where: { id: docId } });
  await fs.rm(doc.storagePath, { force: true }).catch(() => {});
}

async function ensureCategory(id: number) {
  const exists = await prisma.productCategory.findUnique({ where: { id }, select: { id: true } });
  if (!exists) throw HttpError.notFound('Category not found');
}
