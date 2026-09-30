/**
 * Template placeholder rendering.
 *
 * Templates use `{{placeholder}}` tokens in the subject and body. At send time
 * we fill them from the quote/customer context. Tokens are matched
 * case-insensitively and whitespace-tolerant (`{{ customer_name }}`), and a
 * handful of natural aliases map to the same value. Unknown tokens are left as
 * a friendly blank rather than the raw `{{token}}` so a stray placeholder never
 * leaks into a customer-facing email.
 */

/** Aliases → canonical key, so several natural phrasings resolve to one value. */
const ALIASES: Record<string, string> = {
  customer: 'recipient_name',
  customer_name: 'recipient_name',
  customername: 'recipient_name',
  recipient: 'recipient_name',
  name: 'recipient_name',
  customer_email: 'recipient_email',
  email: 'recipient_email',
  category: 'product',
  product_name: 'product',
  make: 'brand',
  title: 'quote_title',
  quote_id: 'quote_number',
  quoteno: 'quote_number',
  amount: 'total',
  grand_total: 'total',
  lines: 'line_count',
  today: 'date',
  sender: 'sender_name',
  from: 'sender_name',
  your_name: 'sender_name',
  your_title: 'sender_title',
  designation: 'sender_title',
  company: 'company_name',
  app_name: 'company_name',
  app: 'company_name',
  your_company_name: 'company_name',
};

export type RenderContext = Record<string, string>;

function normalizeKey(raw: string): string {
  const k = raw.trim().toLowerCase().replace(/[\s-]+/g, '_');
  return ALIASES[k] ?? k;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Replace every `{{token}}` in `text` using `ctx` (unknown tokens → '').
 * Pass `{ escape: true }` when rendering into an HTML template so a value
 * containing `&`, `<`, `"` can't break the markup.
 */
export function renderTemplate(text: string, ctx: RenderContext, opts: { escape?: boolean } = {}): string {
  if (!text) return '';
  return text.replace(/\{\{\s*([\w\s-]+?)\s*\}\}/g, (_m, token: string) => {
    const key = normalizeKey(token);
    const value = ctx[key] ?? '';
    return opts.escape ? escapeHtml(value) : value;
  });
}
