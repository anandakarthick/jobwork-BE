import fs from 'fs/promises';
import type { Prisma } from '@prisma/client';
import { prisma } from '../../lib/prisma';
import { HttpError } from '../../lib/http-error';
import { ingestDocument } from '../price-list/price-list.service';
import { getDocumentText, startTextExtraction } from '../price-list/price-list.text';
import { getEffectiveLlmConfig } from '../../lib/llm';
import { forgetClaudeFile, forgetRuleFiles, startClaudeTraining, startRuleTraining } from './knowledge.service';
// startClaudeTraining / startRuleTraining are used by the explicit Train endpoints below.
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
  // Everything the brand trained into Claude goes with it — rules and files.
  const [rules, docs] = await Promise.all([
    prisma.brandPrompt.findMany({ where: { companyId: id }, select: { id: true } }),
    prisma.productDocument.findMany({ where: { companyId: id }, select: { id: true } }),
  ]);
  await forgetRuleFiles(rules.map((r) => r.id)).catch(() => undefined);
  for (const d of docs) await forgetClaudeFile(d.id).catch(() => undefined);
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
  aiFileId: true,
  aiStatus: true,
  aiError: true,
  aiFileChars: true,
  aiTrainedAt: true,
  aiFileKind: true,
  aiPages: true,
} satisfies Prisma.ProductDocumentSelect;

/** True when Get Quote runs on files trained into Claude (Settings → API Keys). */
async function claudeEngine(): Promise<boolean> {
  return (await getEffectiveLlmConfig()).quoteEngine === 'claude';
}

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
  const claude = await claudeEngine();

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
    if (claude) {
      // Knowledge-in-Claude engine: nothing is parsed or stored in our tables, and
      // nothing is sent to Claude until the user clicks Train on the file.
      continue;
    }
    // Database engine: every file is read into text; trained ones are also ingested.
    await startTextExtraction(doc.id);
    if (train) await ingestDocument(doc.id);
  }

  return listPriceLists(companyId);
}

/** Train one brand file into Claude (upload its text to Anthropic's Files API). */
export async function trainPriceListIntoClaude(companyId: number, docId: number) {
  const doc = await prisma.productDocument.findFirst({ where: { id: docId, companyId } });
  if (!doc) throw HttpError.notFound('Price list not found');
  await startClaudeTraining(docId);
  return prisma.productDocument.findUniqueOrThrow({ where: { id: docId }, select: priceListSelect });
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
  if (await claudeEngine()) {
    // Claude engine: saving changes nothing in Claude — training is the user's
    // explicit Train click. Un-ticking Train removes the file from Claude.
    if (input.train === false && doc.aiFileId) await forgetClaudeFile(docId).catch(() => undefined);
    return prisma.productDocument.findUniqueOrThrow({ where: { id: docId }, select: priceListSelect });
  }
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
  aiFileId: true,
  aiStatus: true,
  aiError: true,
  aiTrainedAt: true,
} satisfies Prisma.BrandPromptSelect;

/** Train one rule into Claude (upload its text to Anthropic's Files API). */
export async function trainPromptIntoClaude(companyId: number, promptId: number) {
  const rule = await prisma.brandPrompt.findFirst({ where: { id: promptId, companyId } });
  if (!rule) throw HttpError.notFound('Rule not found');
  await startRuleTraining(promptId);
  return prisma.brandPrompt.findUniqueOrThrow({ where: { id: promptId }, select: promptSelect });
}

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
  if (removed.length) {
    await forgetRuleFiles(removed).catch(() => undefined); // their copies in Claude go too
    ops.push(prisma.brandPrompt.deleteMany({ where: { id: { in: removed } } }));
  }

  // Rules whose TEXT changed (or are new) need training into Claude again — the
  // file in Claude holds the old wording until then.
  const changedText: number[] = [];
  const created: { name: string }[] = [];
  for (const p of input.prompts) {
    const existing = p.id != null ? currentById.get(p.id) : undefined;
    if (p.id != null && !existing) throw HttpError.badRequest('Prompt does not belong to this brand');
    if (!existing) {
      created.push({ name: p.name });
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
      const textChanged = existing.content !== p.content || existing.name !== p.name;
      if (textChanged) changedText.push(existing.id);
      ops.push(
        prisma.brandPrompt.update({
          where: { id: existing.id },
          data: {
            name: p.name,
            content: p.content,
            train: p.train,
            // Stale in Claude until trained again.
            ...(textChanged && existing.aiStatus !== 'NOT_STARTED' ? { aiStatus: 'NOT_STARTED' as const } : {}),
          },
        }),
      );
    }
  }

  if (ops.length) await prisma.$transaction(ops);
  // Claude engine: nothing is sent to Claude on save — a new or edited rule shows
  // "not trained" until the user clicks Train (again). An untrained selected rule
  // is still sent to a quote as text, so nothing is lost meanwhile.
  void created;
  void changedText;
  return listPrompts(companyId);
}

/**
 * Every keyword prompt of the given brands (by name), for the rule picker on
 * Get Quote: id, name, brand and whether it is trained (= ticked by default).
 */
export async function listPromptsForBrands(brands: string[]) {
  if (brands.length === 0) return [];
  const rows = await prisma.brandPrompt.findMany({
    where: { company: { name: { in: brands } } },
    select: { id: true, name: true, train: true, aiStatus: true, company: { select: { name: true } } },
    orderBy: [{ companyId: 'asc' }, { id: 'asc' }],
  });
  return rows.map((r) => ({ id: r.id, name: r.name, train: r.train, aiStatus: r.aiStatus, brand: r.company.name }));
}

/**
 * The keyword prompts of the given brands as one text block grouped by brand —
 * sent to the model when generating a quote and on every chat turn. With
 * `promptIds` only those prompts are used (the rules the user picked for the
 * chat); otherwise every trained prompt. Empty when there are none.
 */
export async function getTrainedPromptText(
  brands: string[],
  promptIds: number[] | null = null,
): Promise<string> {
  if (brands.length === 0) return '';
  const rows = await prisma.brandPrompt.findMany({
    where: {
      company: { name: { in: brands } },
      ...(promptIds ? { id: { in: promptIds } } : { train: true }),
    },
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
  // Its copy in Claude goes too, so a deleted file is never read again.
  await forgetClaudeFile(docId).catch(() => undefined);
  await prisma.productDocument.delete({ where: { id: docId } });
  await fs.rm(doc.storagePath, { force: true }).catch(() => {});
}
