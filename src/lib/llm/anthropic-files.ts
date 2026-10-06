/**
 * Anthropic Files API — the "knowledge in Claude" store. A brand file is
 * uploaded ONCE (as its extracted text) and Anthropic returns a file id; from
 * then on every quote request only sends that id and Claude reads the file on
 * its side. Nothing from the file is parsed into our tables.
 *
 * Files API is in beta: every call carries the beta header. An organisation-wide
 * (default) API key must also name the workspace the files belong to via the
 * `anthropic-workspace-id` header; a workspace-scoped key needs no header.
 */
import Anthropic, { toFile } from '@anthropic-ai/sdk';
import { friendlyErrorMessage } from './errors';

export const FILES_BETA = 'files-api-2025-04-14' as const;

export interface AnthropicAuth {
  apiKey: string;
  /** "wrkspc_…" from the Anthropic Console → Settings → Workspaces; optional. */
  workspaceId?: string;
}

/** An SDK client carrying the workspace header when one is configured. */
export function anthropicClient(auth: AnthropicAuth): Anthropic {
  return new Anthropic({
    apiKey: auth.apiKey,
    ...(auth.workspaceId ? { defaultHeaders: { 'anthropic-workspace-id': auth.workspaceId } } : {}),
  });
}

export interface UploadedKnowledgeFile {
  id: string;
  sizeBytes: number;
}

/** Upload a brand file's text as a plain-text file; returns Anthropic's file id. */
export async function uploadKnowledgeText(
  auth: AnthropicAuth,
  fileName: string,
  text: string,
): Promise<UploadedKnowledgeFile> {
  const file = await toFile(Buffer.from(text, 'utf8'), fileName, { type: 'text/plain' });
  const meta = await anthropicClient(auth).beta.files.upload({ file, betas: [FILES_BETA] });
  return { id: meta.id, sizeBytes: meta.size_bytes };
}

/** Anthropic's limits for attaching a PDF as a document (per request / per file). */
export const PDF_MAX_PAGES_PER_REQUEST = 100;
export const PDF_MAX_BYTES = 32 * 1024 * 1024;

/** Upload a file as-is (e.g. the original PDF, so Claude sees pages + images). */
export async function uploadKnowledgeFile(
  auth: AnthropicAuth,
  filePath: string,
  fileName: string,
  mimeType: string,
): Promise<UploadedKnowledgeFile> {
  const { readFile } = await import('fs/promises');
  const file = await toFile(await readFile(filePath), fileName, { type: mimeType });
  const meta = await anthropicClient(auth).beta.files.upload({ file, betas: [FILES_BETA] });
  return { id: meta.id, sizeBytes: meta.size_bytes };
}

/** Remove a file from Anthropic (re-training replaces, deleting the old one). */
export async function deleteKnowledgeFile(auth: AnthropicAuth, fileId: string): Promise<void> {
  await anthropicClient(auth)
    .beta.files.delete(fileId, { betas: [FILES_BETA] })
    .catch((err: unknown) => {
      // A file already gone (404) is fine — the goal is that it no longer exists.
      const status = (err as { status?: number }).status;
      if (status !== 404) throw err;
    });
}

/** True when the file still exists on Anthropic's side. */
export async function knowledgeFileExists(auth: AnthropicAuth, fileId: string): Promise<boolean> {
  try {
    await anthropicClient(auth).beta.files.retrieveMetadata(fileId, { betas: [FILES_BETA] });
    return true;
  } catch (err) {
    if ((err as { status?: number }).status === 404) return false;
    throw err;
  }
}

/** Turn an Anthropic error into a sentence a user can act on. */
export function explainAnthropicError(err: unknown): string {
  return friendlyErrorMessage(err, 'Training into Claude failed');
}
