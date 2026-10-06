/**
 * Provider-neutral LLM contract.
 *
 * Nothing in the jobwork module talks to OpenAI or Anthropic directly — it only
 * depends on `LlmProvider`. Swap the concrete provider (see ./providers) without
 * touching the service or routes.
 */

export type LlmRole = 'system' | 'user' | 'assistant';

export interface LlmMessage {
  role: LlmRole;
  content: string;
}

/** A source document on local disk, passed to the provider for analysis. */
export interface LlmDocument {
  fileName: string;
  mimeType: string;
  /** Absolute or project-relative path to the stored file. */
  path: string;
}

/** Our catalogue, given to the model as context so it can map parts to what we sell. */
export interface CatalogueContext {
  categories: { id: number; name: string; brands: string[] }[];
  companies: { id: number; name: string; status: string }[];
}

/** One extracted part requirement. Shape matches the jobwork_requirements table. */
export interface ExtractedRequirement {
  partName: string;
  quantity: number | null;
  specifications: string | null;
  /** Matched product category id from the provided catalogue, or null. */
  matchedCategoryId: number | null;
  /** Suggested supplier brands/companies (names). */
  suggestedBrands: string[];
  notes: string | null;
}

export interface AnalyzeInput {
  customerName: string;
  documents: LlmDocument[];
  catalogue: CatalogueContext;
  /** Optional free-text instruction from the user. */
  instructions?: string;
}

export interface AnalyzeResult {
  summary: string;
  requirements: ExtractedRequirement[];
}

/** Options for a raw completion call. */
export interface CompleteOptions {
  /** Stable system prompt (cached as a prefix where the provider supports it). */
  system?: string;
  /** Force the model to return a single JSON value (object/array). */
  json?: boolean;
  maxTokens?: number;
  /** Optional tag recorded with usage metering (e.g. "quote:extract"). */
  label?: string;
  /** "fast" runs the provider's cheap model (small jobs); default = main model. */
  tier?: 'main' | 'fast';
}

/**
 * One block of a multimodal message: plain text, an inline image, or a PDF
 * document. Images/documents carry base64 data (no `data:` prefix) + mime type.
 */
export interface LlmContentPart {
  type: 'text' | 'image' | 'document';
  /** for type 'text' */
  text?: string;
  /** for 'image' / 'document' */
  mimeType?: string;
  dataBase64?: string;
}

export interface LlmProvider {
  /** Short id stored on the analysis row: "stub" | "openai" | "claude". */
  readonly name: string;
  /** True when the provider has everything it needs (e.g. an API key) to run. */
  isConfigured(): boolean;
  /** Examine the documents and return part requirements + a summary. */
  analyze(input: AnalyzeInput): Promise<AnalyzeResult>;
  /** Free-form chat turn given the full message history. */
  chat(messages: LlmMessage[]): Promise<string>;
  /**
   * Low-level completion used by the quote pipeline. Returns the model's text
   * (a JSON string when `opts.json` is set). System prompt goes via `opts.system`.
   */
  complete(messages: LlmMessage[], opts?: CompleteOptions): Promise<string>;
  /**
   * Multimodal completion — a single user turn made of text + image/PDF parts.
   * Used by price-list ingestion to read scans/images. Returns the model's text
   * (JSON when `opts.json` is set).
   */
  completeParts(parts: LlmContentPart[], opts?: CompleteOptions): Promise<string>;
  /**
   * Knowledge completion: the brand's files (already stored with the provider,
   * referenced by id) are attached to the conversation and the model answers
   * from them. Only providers with a file store implement it (Claude).
   */
  completeWithKnowledge?(input: KnowledgeInput, opts?: CompleteOptions): Promise<string>;
}

/** A knowledge completion: provider-stored files + a conversation. */
export interface KnowledgeInput {
  /** Provider file ids (Anthropic Files API) attached to the FIRST user turn. */
  fileIds: string[];
  /** Conversation; the first user turn carries the files, the rest follow. */
  messages: LlmMessage[];
}

/** Thrown when a selected provider is missing its API key / config. */
export class LlmNotConfiguredError extends Error {
  constructor(providerName: string) {
    super(`LLM provider "${providerName}" is not configured (missing API key).`);
    this.name = 'LlmNotConfiguredError';
  }
}
