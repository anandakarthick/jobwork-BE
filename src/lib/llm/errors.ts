/**
 * Turn a provider (Anthropic / OpenAI) API failure into a sentence the user can
 * act on, plus an HTTP status for the API response. Anything that is not a
 * provider error returns null so callers fall back to their own handling.
 */
export interface LlmErrorInfo {
  status: number;
  message: string;
}

/** Pull `{status, message}` out of an SDK error or a "400 {json}" message string. */
function extract(err: unknown): { status: number | null; message: string } | null {
  if (!err) return null;
  const e = err as { status?: unknown; error?: unknown; message?: unknown; name?: unknown };
  const raw = typeof e.message === 'string' ? e.message : String(err);

  // SDK errors carry .status and a parsed body under .error (Anthropic: {type,error:{message}}; OpenAI: {message}).
  const body = e.error as { error?: { message?: unknown }; message?: unknown } | undefined;
  const bodyMsg =
    (body && typeof body.error?.message === 'string' && body.error.message) ||
    (body && typeof body.message === 'string' && body.message) ||
    null;
  if (typeof e.status === 'number' && bodyMsg) return { status: e.status, message: bodyMsg };

  // Serialised form: `400 {"type":"error","error":{"type":"…","message":"…"}}`.
  const m = /^(\d{3})\s+(\{.*\})\s*$/s.exec(raw);
  if (m) {
    try {
      const json = JSON.parse(m[2]!) as { error?: { message?: unknown }; message?: unknown };
      const msg =
        (typeof json.error?.message === 'string' && json.error.message) ||
        (typeof json.message === 'string' && json.message) ||
        raw;
      return { status: Number(m[1]), message: msg };
    } catch {
      return { status: Number(m[1]), message: raw };
    }
  }
  if (typeof e.status === 'number' && /api|anthropic|openai/i.test(String(e.name ?? ''))) {
    return { status: e.status, message: raw };
  }
  return null;
}

/** A user-facing description of a provider API error, or null if `err` isn't one. */
export function describeLlmError(err: unknown): LlmErrorInfo | null {
  const found = extract(err);
  if (!found) return null;
  const msg = found.message;
  const lower = msg.toLowerCase();

  if (lower.includes('credit balance') || lower.includes('insufficient_quota') || lower.includes('billing')) {
    return {
      status: 402,
      message:
        'The AI account has run out of credit, so this request could not be processed. ' +
        'Add credit at console.anthropic.com → Plans & Billing (or your OpenAI billing page), then try again.',
    };
  }
  if (found.status === 401 || lower.includes('invalid x-api-key') || lower.includes('authentication')) {
    return { status: 400, message: 'The AI API key is invalid or has been revoked. Check it in Settings → API Keys.' };
  }
  if (lower.includes('anthropic-workspace-id') || lower.includes('scoped to a workspace')) {
    return {
      status: 400,
      message:
        'Anthropic needs the Workspace ID for this request (Settings → API Keys → Claude → Workspace ID, ' +
        'from console.anthropic.com → Settings → Workspaces), or an API key created inside a workspace.',
    };
  }
  if (found.status === 429 || lower.includes('rate limit')) {
    return { status: 429, message: 'The AI provider is rate-limiting requests right now. Wait a minute and try again.' };
  }
  if (found.status === 529 || lower.includes('overloaded')) {
    return { status: 503, message: 'The AI provider is overloaded at the moment. Try again in a few minutes.' };
  }
  if (lower.includes('prompt is too long') || lower.includes('context window') || lower.includes('too many tokens')) {
    return {
      status: 400,
      message:
        'This request is too large for the AI model (price lists + BOQ exceed its context). ' +
        'Attach fewer brands, or re-train the price lists so their catalogue index is used.',
    };
  }
  if (lower.includes('not_found_error') || (found.status === 404 && lower.includes('file'))) {
    return {
      status: 400,
      message: 'A trained file no longer exists in Claude. Open the brand and click Train again on its files and rules.',
    };
  }
  return {
    status: found.status != null && found.status >= 400 && found.status < 500 ? 400 : 502,
    message: `AI provider error: ${msg}`,
  };
}

/** Message for a failure that may or may not be a provider error. */
export function friendlyErrorMessage(err: unknown, fallback = 'Something went wrong'): string {
  return describeLlmError(err)?.message ?? (err instanceof Error ? err.message : fallback);
}
