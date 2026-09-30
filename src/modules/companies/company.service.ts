import fs from 'fs/promises';
import type { Prisma } from '@prisma/client';
import { prisma } from '../../lib/prisma';
import { HttpError } from '../../lib/http-error';
import { ingestDocument } from '../price-list/price-list.service';
import { getDocumentText, startTextExtraction } from '../price-list/price-list.text';
import type {
  CreateCompanyInput,
  ListCompaniesQuery,
  SavePromptsInput,
  UpdateCompanyInput,
  UpdatePriceListInput,
} from './company.schema';

export interface StoredFile {
  originalName: string;
  storedName: string;
  mimeType: string;
  sizeBytes: number;
  path: string;
}

const withCreator = {
  createdBy: { select: { id: true, name: true, email: true } },
} satisfies Prisma.CompanyInclude;

/** Treat empty strings from the form as "not set". */
const nullify = (v: string | null | undefined) => {
  const trimmed = v?.trim();
  return trimmed ? trimmed : null;
};

export async function listCompanies(query: ListCompaniesQuery) {
  const where: Prisma.CompanyWhereInput = {
    ...(query.status ? { status: query.status } : {}),
    ...(query.search
      ? {
          OR: [
            { name: { contains: query.search } },
            { email: { contains: query.search } },
          ],
        }
      : {}),
  };

  const [rows, total] = await Promise.all([
    prisma.company.findMany({
      where,
      include: { ...withCreator, _count: { select: { priceListDocuments: true } } },
      orderBy: { name: 'asc' },
      skip: (query.page - 1) * query.limit,
      take: query.limit,
    }),
    prisma.company.count({ where }),
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

export function getCompany(id: number) {
  return prisma.company.findUniqueOrThrow({ where: { id }, include: withCreator });
}

export function createCompany(input: CreateCompanyInput, userId: number) {
  return prisma.company.create({
    data: {
      name: input.name,
      status: input.status,
      email: nullify(input.email),
      phone: nullify(input.phone),
      address: nullify(input.address),
      description: nullify(input.description),
      createdById: userId,
    },
    include: withCreator,
  });
}

export function updateCompany(id: number, input: UpdateCompanyInput) {
  return prisma.company.update({
    where: { id },
    data: {
      ...(input.name !== undefined ? { name: input.name } : {}),
      ...(input.status !== undefined ? { status: input.status } : {}),
      ...(input.email !== undefined ? { email: nullify(input.email) } : {}),
      ...(input.phone !== undefined ? { phone: nullify(input.phone) } : {}),
      ...(input.address !== undefined ? { address: nullify(input.address) } : {}),
      ...(input.description !== undefined ? { description: nullify(input.description) } : {}),
    },
    include: withCreator,
  });
}

export function setStatus(id: number, status: 'ACTIVE' | 'INACTIVE') {
  return prisma.company.update({ where: { id }, data: { status }, include: withCreator });
}

export async function deleteCompany(id: number) {
  await prisma.company.delete({ where: { id } });
}

// ---------- Brand price-list documents ----------
// A brand (company) owns one or more price-list files. Uploading one marks it
// as a PRICE_LIST for this brand (companyId + brand set, no category), ready to
// ingest into price_list_items via the shared price-list ingest pipeline.

const priceListSelect = {
  id: true,
  name: true,
  fileName: true,
  mimeType: true,
  sizeBytes: true,
  createdAt: true,
  updatedAt: true,
  kind: true,
  brand: true,
  train: true,
  ingestStatus: true,
  ingestedItemCount: true,
  ingestError: true,
  textStatus: true,
  textChars: true,
  textSource: true,
  textError: true,
} satisfies Prisma.ProductDocumentSelect;

async function ensureCompany(id: number): Promise<{ id: number; name: string }> {
  const co = await prisma.company.findUnique({ where: { id }, select: { id: true, name: true } });
  if (!co) throw HttpError.notFound('Brand not found');
  return co;
}

export async function listPriceLists(companyId: number) {
  await ensureCompany(companyId);
  return prisma.productDocument.findMany({
    where: { companyId, kind: 'PRICE_LIST' },
    select: priceListSelect,
    orderBy: { id: 'asc' },
  });
}

/**
 * Store uploaded files for a brand. `trainFlags[i]` says whether file `i` should
 * be trained (ingested into price_list_items and used by Get Quote); a file with
 * no flag is only stored. `names[i]` is the label the user gave file `i`.
 * Training runs in the background.
 */
export async function addPriceLists(
  companyId: number,
  files: StoredFile[],
  userId: number,
  trainFlags: boolean[] = [],
  names: string[] = [],
) {
  const company = await ensureCompany(companyId);
  if (files.length === 0) throw HttpError.badRequest('No files uploaded');

  for (const [i, f] of files.entries()) {
    const train = trainFlags[i] === true;
    const doc = await prisma.productDocument.create({
      data: {
        companyId,
        categoryId: null,
        brand: company.name, // the brand a price list belongs to = the company name
        kind: 'PRICE_LIST',
        train,
        name: names[i] || null,
        fileName: f.originalName,
        storedName: f.storedName,
        mimeType: f.mimeType,
        sizeBytes: f.sizeBytes,
        storagePath: f.path,
        createdById: userId,
      },
      select: { id: true },
    });
    // Every file is read into text; only trained ones are also ingested.
    await startTextExtraction(doc.id);
    if (train) await ingestDocument(doc.id);
  }

  return listPriceLists(companyId);
}

/**
 * Rename one of a brand's files and/or turn its training on/off. Turning
 * training on trains the file if it isn't trained yet (or failed last time);
 * turning it off keeps the parsed rows but excludes the file from Get Quote.
 */
export async function updatePriceList(
  companyId: number,
  docId: number,
  input: UpdatePriceListInput,
) {
  const doc = await prisma.productDocument.findFirst({ where: { id: docId, companyId } });
  if (!doc) throw HttpError.notFound('Price list not found');

  await prisma.productDocument.update({
    where: { id: docId },
    data: {
      ...(input.name !== undefined ? { name: input.name || null } : {}),
      ...(input.train !== undefined ? { train: input.train } : {}),
    },
  });
  // A file whose text was never read (or failed) is read now, on any save.
  if (doc.textStatus === 'NOT_STARTED' || doc.textStatus === 'FAILED') {
    await startTextExtraction(docId);
  }
  if (input.train && (doc.ingestStatus === 'NOT_STARTED' || doc.ingestStatus === 'FAILED')) {
    await ingestDocument(docId);
  }
  return prisma.productDocument.findUniqueOrThrow({ where: { id: docId }, select: priceListSelect });
}

// ---------- Brand keyword prompts ----------

const promptSelect = {
  id: true,
  name: true,
  content: true,
  train: true,
  createdAt: true,
  updatedAt: true,
} satisfies Prisma.BrandPromptSelect;

export async function listPrompts(companyId: number) {
  await ensureCompany(companyId);
  return prisma.brandPrompt.findMany({
    where: { companyId },
    select: promptSelect,
    orderBy: { id: 'asc' },
  });
}

/**
 * Replace a brand's prompts with the submitted list. Only rows whose name, text
 * or train flag actually changed are written, so `updatedAt` keeps meaning "last
 * edited" for the rows the user didn't touch.
 */
export async function savePrompts(companyId: number, input: SavePromptsInput) {
  await ensureCompany(companyId);
  const current = await prisma.brandPrompt.findMany({ where: { companyId } });
  const currentById = new Map(current.map((p) => [p.id, p]));
  const keptIds = new Set(input.prompts.flatMap((p) => (p.id != null ? [p.id] : [])));

  const ops: Prisma.PrismaPromise<unknown>[] = [];
  const removed = current.filter((p) => !keptIds.has(p.id)).map((p) => p.id);
  if (removed.length) ops.push(prisma.brandPrompt.deleteMany({ where: { id: { in: removed } } }));

  for (const p of input.prompts) {
    const existing = p.id != null ? currentById.get(p.id) : undefined;
    if (p.id != null && !existing) throw HttpError.badRequest('Prompt does not belong to this brand');
    if (!existing) {
      ops.push(
        prisma.brandPrompt.create({
          data: { companyId, name: p.name, content: p.content, train: p.train },
        }),
      );
    } else if (
      existing.name !== p.name ||
      existing.content !== p.content ||
      existing.train !== p.train
    ) {
      ops.push(
        prisma.brandPrompt.update({
          where: { id: existing.id },
          data: { name: p.name, content: p.content, train: p.train },
        }),
      );
    }
  }

  if (ops.length) await prisma.$transaction(ops);
  return listPrompts(companyId);
}

/**
 * The trained keyword prompts of the given brands, as one text block grouped by
 * brand — sent to the model when generating a quote. Empty when there are none.
 */
export async function getTrainedPromptText(brands: string[]): Promise<string> {
  if (brands.length === 0) return '';
  const rows = await prisma.brandPrompt.findMany({
    where: { train: true, company: { name: { in: brands } } },
    select: { name: true, content: true, company: { select: { name: true } } },
    orderBy: { id: 'asc' },
  });
  const byBrand = new Map<string, string[]>();
  for (const r of rows) {
    const text = r.content.trim();
    if (!text) continue;
    // The prompt's own name (e.g. "Rule 1") heads its text so the model can tell rules apart.
    const note = r.name.trim() ? `${r.name.trim()}:\n${text}` : text;
    (byBrand.get(r.company.name) ?? byBrand.set(r.company.name, []).get(r.company.name)!).push(note);
  }
  return [...byBrand.entries()]
    .map(([brand, notes]) => `Brand "${brand}":\n${notes.join('\n\n')}`)
    .join('\n\n');
}

export async function getPriceListForDownload(companyId: number, docId: number) {
  const doc = await prisma.productDocument.findFirst({ where: { id: docId, companyId } });
  if (!doc) throw HttpError.notFound('Price list not found');
  return doc;
}

/** The extracted text of one of a brand's files, for download as a .txt. */
export async function getPriceListText(companyId: number, docId: number) {
  const doc = await prisma.productDocument.findFirst({
    where: { id: docId, companyId },
    select: { id: true, fileName: true },
  });
  if (!doc) throw HttpError.notFound('Price list not found');
  return { fileName: doc.fileName, text: await getDocumentText(doc.id) };
}

export async function deletePriceList(companyId: number, docId: number) {
  const doc = await prisma.productDocument.findFirst({ where: { id: docId, companyId } });
  if (!doc) throw HttpError.notFound('Price list not found');
  await prisma.productDocument.delete({ where: { id: docId } });
  await fs.rm(doc.storagePath, { force: true }).catch(() => {});
}
