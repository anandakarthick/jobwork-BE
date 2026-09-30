import type { Prisma } from '@prisma/client';
import { prisma } from '../../lib/prisma';
import { HttpError } from '../../lib/http-error';
import {
  getLlmProvider,
  type CatalogueContext,
  type ExtractedRequirement,
  type LlmDocument,
  type LlmMessage,
} from '../../lib/llm';
import type { CreateAnalysisInput, ListAnalysesQuery } from './jobwork.schema';

const detailInclude = {
  customer: { select: { id: true, name: true, email: true, phone: true } },
  category: { select: { id: true, name: true, brands: true } },
  documents: { orderBy: { id: 'asc' } },
  messages: { orderBy: { createdAt: 'asc' } },
  requirements: {
    include: { matchedCategory: { select: { id: true, name: true } } },
    orderBy: { id: 'asc' },
  },
} satisfies Prisma.JobworkAnalysisInclude;

/** Metadata for a stored upload, as produced by the multer middleware. */
export interface StoredFile {
  originalName: string;
  storedName: string;
  mimeType: string;
  sizeBytes: number;
  path: string;
}

/** Loads our catalogue so the model can map requirements to what we sell. */
async function loadCatalogue(): Promise<CatalogueContext> {
  const [categories, companies] = await Promise.all([
    prisma.productCategory.findMany({ select: { id: true, name: true, brands: true } }),
    prisma.company.findMany({ select: { id: true, name: true, status: true } }),
  ]);
  return {
    categories: categories.map((c) => ({
      id: c.id,
      name: c.name,
      brands: Array.isArray(c.brands) ? (c.brands as string[]) : [],
    })),
    companies: companies.map((c) => ({ id: c.id, name: c.name, status: c.status })),
  };
}

export async function listAnalyses(query: ListAnalysesQuery) {
  const where: Prisma.JobworkAnalysisWhereInput = query.customerId
    ? { customerId: query.customerId }
    : {};

  const [rows, total] = await Promise.all([
    prisma.jobworkAnalysis.findMany({
      where,
      include: {
        customer: { select: { id: true, name: true } },
        _count: { select: { documents: true, requirements: true } },
      },
      orderBy: { createdAt: 'desc' },
      skip: (query.page - 1) * query.limit,
      take: query.limit,
    }),
    prisma.jobworkAnalysis.count({ where }),
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

export function getAnalysis(id: number) {
  return prisma.jobworkAnalysis.findUniqueOrThrow({ where: { id }, include: detailInclude });
}

/**
 * Create an analysis from a customer + uploaded documents, run it through the
 * active LLM provider, and persist the extracted requirements + chat thread.
 */
export async function createAnalysis(
  input: CreateAnalysisInput,
  files: StoredFile[],
  userId: number,
) {
  const customer = await prisma.customer.findUnique({ where: { id: input.customerId } });
  if (!customer) throw HttpError.badRequest('Customer not found');

  // Validate the optional product category.
  let category: { id: number; name: string } | null = null;
  if (input.categoryId) {
    const found = await prisma.productCategory.findUnique({
      where: { id: input.categoryId },
      select: { id: true, name: true },
    });
    if (!found) throw HttpError.badRequest('Product category not found');
    category = found;
  }

  // 1. Create the analysis with its documents + the opening user message.
  const contextLine = [
    category ? `Product: ${category.name}` : null,
    input.brands.length ? `Brands: ${input.brands.join(', ')}` : null,
  ]
    .filter(Boolean)
    .join(' · ');
  const userText =
    (input.instructions?.trim() || `Analyze ${files.length} document(s).`) +
    (contextLine ? `\n${contextLine}` : '');

  const analysis = await prisma.jobworkAnalysis.create({
    data: {
      title: input.title ?? null,
      status: 'PROCESSING',
      customerId: input.customerId,
      categoryId: category?.id ?? null,
      brands: input.brands,
      createdById: userId,
      documents: {
        create: files.map((f) => ({
          fileName: f.originalName,
          storedName: f.storedName,
          mimeType: f.mimeType,
          sizeBytes: f.sizeBytes,
          storagePath: f.path,
        })),
      },
      messages: { create: [{ role: 'USER', content: userText }] },
    },
  });

  // 2. Run the provider (stub for now).
  const provider = await getLlmProvider();
  const catalogue = await loadCatalogue();
  const validCategoryIds = new Set(catalogue.categories.map((c) => c.id));
  const docs: LlmDocument[] = files.map((f) => ({
    fileName: f.originalName,
    mimeType: f.mimeType,
    path: f.path,
  }));

  try {
    const result = await provider.analyze({
      customerName: customer.name,
      documents: docs,
      catalogue,
      instructions: input.instructions,
    });

    // Only keep matched category ids that actually exist.
    const cleanRequirements: ExtractedRequirement[] = result.requirements.map((r) => ({
      ...r,
      matchedCategoryId:
        r.matchedCategoryId && validCategoryIds.has(r.matchedCategoryId)
          ? r.matchedCategoryId
          : null,
      suggestedBrands: Array.isArray(r.suggestedBrands) ? r.suggestedBrands : [],
    }));

    await prisma.$transaction([
      prisma.jobworkAnalysis.update({
        where: { id: analysis.id },
        data: { status: 'COMPLETED', summary: result.summary, provider: provider.name, error: null },
      }),
      prisma.jobworkMessage.create({
        data: { analysisId: analysis.id, role: 'ASSISTANT', content: result.summary },
      }),
      ...(cleanRequirements.length
        ? [
            prisma.jobworkRequirement.createMany({
              data: cleanRequirements.map((r) => ({
                analysisId: analysis.id,
                partName: r.partName,
                quantity: r.quantity,
                specifications: r.specifications,
                matchedCategoryId: r.matchedCategoryId,
                suggestedBrands: r.suggestedBrands,
                notes: r.notes,
              })),
            }),
          ]
        : []),
    ]);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Analysis failed';
    await prisma.$transaction([
      prisma.jobworkAnalysis.update({
        where: { id: analysis.id },
        data: { status: 'FAILED', provider: provider.name, error: message },
      }),
      prisma.jobworkMessage.create({
        data: { analysisId: analysis.id, role: 'ASSISTANT', content: `Analysis failed: ${message}` },
      }),
    ]);
  }

  return getAnalysis(analysis.id);
}

/** Append a user message, get a provider reply, and store both. */
export async function addMessage(analysisId: number, content: string) {
  const analysis = await prisma.jobworkAnalysis.findUnique({
    where: { id: analysisId },
    include: { customer: { select: { name: true } }, messages: { orderBy: { createdAt: 'asc' } } },
  });
  if (!analysis) throw HttpError.notFound('Analysis not found');

  await prisma.jobworkMessage.create({
    data: { analysisId, role: 'USER', content },
  });

  const provider = await getLlmProvider();
  const history: LlmMessage[] = [
    {
      role: 'system',
      content:
        `You are a job-work requirement assistant for customer "${analysis.customer.name}". ` +
        `Answer questions about the uploaded documents and the extracted part requirements.`,
    },
    ...analysis.messages.map((m) => ({
      role: m.role.toLowerCase() as LlmMessage['role'],
      content: m.content,
    })),
    { role: 'user', content },
  ];

  let reply: string;
  try {
    reply = await provider.chat(history);
  } catch (err) {
    reply = `Could not get a reply: ${err instanceof Error ? err.message : 'unknown error'}`;
  }

  const assistant = await prisma.jobworkMessage.create({
    data: { analysisId, role: 'ASSISTANT', content: reply },
  });

  return assistant;
}

export async function deleteAnalysis(id: number) {
  await prisma.jobworkAnalysis.delete({ where: { id } });
}
