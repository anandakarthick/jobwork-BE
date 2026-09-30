/**
 * The letter-pad (letterhead) DESIGN — the branded HTML shell every outgoing
 * email is wrapped in. Pages supply their own body content; the design only
 * provides the frame (header with logo/company, title band, footer).
 *
 * Slots filled at send time:
 *   {{content}}       – the page's body HTML (NOT escaped; we build it)
 *   {{logo}}          – <img> of the company logo (or empty) — NOT escaped
 *   {{title}}         – the letter title (e.g. "Your Account", "Quotation")
 *   {{company_name}}  – app/company name
 *   {{date}}          – today's date
 */
import { prisma } from '../../lib/prisma';
import { renderTemplate } from './email.render';

interface Palette {
  pageBg: string;
  cardBg: string;
  cardBorder: string; // e.g. 'border:1px solid #eee;' or ''
  headerBg: string;
  headerBorder: string; // bottom border under the header (or '')
  headerText: string;
  headerSub: string;
  titleColor: string;
  bodyText: string;
  footerBg: string;
  footerText: string;
  border: string;
  font: string;
}

/** Build one letter-pad design from a colour palette. */
function build(p: Palette): string {
  return `<div style="margin:0;padding:0;background:${p.pageBg};font-family:${p.font};">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${p.pageBg};padding:24px 0;">
    <tr><td align="center">
      <table role="presentation" width="640" cellpadding="0" cellspacing="0" style="width:640px;max-width:100%;background:${p.cardBg};border-radius:12px;overflow:hidden;${p.cardBorder}">
        <tr><td style="background:${p.headerBg};padding:22px 28px;${p.headerBorder}">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>
            <td style="vertical-align:middle;">
              <div style="color:${p.headerText};font-size:19px;font-weight:bold;letter-spacing:.3px;">{{company_name}}</div>
              <div style="color:${p.headerSub};font-size:11px;line-height:1.6;margin-top:4px;">
                Devon Rd, Hempstead, NY &nbsp;|&nbsp; yourinfo@emailaddress.com<br>
                www.yourcompany.com &nbsp;|&nbsp; 222 555 7777
              </div>
            </td>
            <td align="right" style="vertical-align:middle;">{{logo}}</td>
          </tr></table>
        </td></tr>
        <tr><td style="padding:28px 28px 4px 28px;">
          <h1 style="margin:0;font-size:23px;font-weight:bold;color:${p.titleColor};text-align:center;">{{title}}</h1>
        </td></tr>
        <tr><td style="padding:14px 28px 28px 28px;font-size:14px;line-height:1.7;color:${p.bodyText};">{{content}}</td></tr>
        <tr><td style="background:${p.footerBg};padding:14px 28px;border-top:1px solid ${p.border};text-align:center;">
          <span style="font-size:11px;color:${p.footerText};">Sent by {{company_name}} on {{date}}</span>
        </td></tr>
      </table>
    </td></tr>
  </table>
</div>`;
}

const SANS = 'Arial,Helvetica,sans-serif';

/** The selectable themed formats shown in Settings → Email Template. */
export const LETTERHEAD_PRESETS: {
  key: string;
  name: string;
  description: string;
  /** CSS background for the card swatch (solid colour or gradient). */
  color: string;
  html: string;
}[] = [
  {
    key: 'modern-purple',
    name: 'Modern Purple',
    description: 'Clean gradient design with purple theme',
    color: 'linear-gradient(135deg,#6d5efc 0%,#9b6dff 100%)',
    html: build({
      pageBg: '#f3f0ff',
      cardBg: '#ffffff',
      cardBorder: 'box-shadow:0 1px 3px rgba(76,29,149,.12);',
      headerBg: 'linear-gradient(135deg,#6d5efc 0%,#9b6dff 100%)',
      headerBorder: '',
      headerText: '#ffffff',
      headerSub: '#ece7ff',
      titleColor: '#5b21b6',
      bodyText: '#374151',
      footerBg: '#faf9ff',
      footerText: '#8b7ff0',
      border: '#ece8ff',
      font: SANS,
    }),
  },
  {
    key: 'professional-blue',
    name: 'Professional Blue',
    description: 'Corporate style with blue accents',
    color: '#1e88e5',
    html: build({
      pageBg: '#eff6ff',
      cardBg: '#ffffff',
      cardBorder: 'box-shadow:0 1px 3px rgba(30,64,175,.10);',
      headerBg: '#1e88e5',
      headerBorder: '',
      headerText: '#ffffff',
      headerSub: '#cfe4fb',
      titleColor: '#0b4a8f',
      bodyText: '#374151',
      footerBg: '#f5f9ff',
      footerText: '#7aa7d6',
      border: '#dbeafe',
      font: SANS,
    }),
  },
  {
    key: 'minimal-clean',
    name: 'Minimal Clean',
    description: 'Simple white design with subtle borders',
    color: 'linear-gradient(135deg,#64748b 0%,#94a3b8 100%)',
    html: build({
      pageBg: '#ffffff',
      cardBg: '#ffffff',
      cardBorder: 'border:1px solid #e5e7eb;',
      headerBg: '#ffffff',
      headerBorder: 'border-bottom:2px solid #e5e7eb;',
      headerText: '#111827',
      headerSub: '#9ca3af',
      titleColor: '#111827',
      bodyText: '#374151',
      footerBg: '#f9fafb',
      footerText: '#9ca3af',
      border: '#e5e7eb',
      font: SANS,
    }),
  },
  {
    key: 'vibrant-green',
    name: 'Vibrant Green',
    description: 'Fresh and energetic green theme',
    color: '#10b981',
    html: build({
      pageBg: '#ecfdf5',
      cardBg: '#ffffff',
      cardBorder: 'box-shadow:0 1px 3px rgba(5,150,105,.12);',
      headerBg: '#10b981',
      headerBorder: '',
      headerText: '#ffffff',
      headerSub: '#d1fae5',
      titleColor: '#065f46',
      bodyText: '#374151',
      footerBg: '#f0fdf9',
      footerText: '#34d399',
      border: '#d1fae5',
      font: SANS,
    }),
  },
  {
    key: 'elegant-dark',
    name: 'Elegant Dark',
    description: 'Sophisticated dark theme with gold accents',
    color: 'linear-gradient(135deg,#0f172a 0%,#1e293b 100%)',
    html: build({
      pageBg: '#0b1220',
      cardBg: '#111827',
      cardBorder: 'border:1px solid #1f2937;',
      headerBg: '#0f172a',
      headerBorder: 'border-bottom:1px solid #1f2937;',
      headerText: '#e5e7eb',
      headerSub: '#94a3b8',
      titleColor: '#e0b34a',
      bodyText: '#cbd5e1',
      footerBg: '#0f172a',
      footerText: '#94a3b8',
      border: '#1f2937',
      font: SANS,
    }),
  },
];

/** Default letter-pad design (the first themed format). */
export const DEFAULT_LETTERHEAD = LETTERHEAD_PRESETS[0]!.html;

export interface WrapContext {
  title: string;
  company_name: string;
  date: string;
}

function escapeAttr(s: string): string {
  return s.replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** Build the logo `<img>` (or empty) from the stored branding logo data URL. */
async function buildLogoHtml(companyName: string): Promise<string> {
  const app = await prisma.appSetting.findUnique({ where: { id: 1 } });
  if (!app?.logo) return '';
  return `<img src="${app.logo}" alt="${escapeAttr(companyName)}" style="max-height:48px;max-width:170px;display:inline-block;border-radius:6px;">`;
}

/**
 * Wrap a page's body HTML in the configured letter-pad. Falls back to a plain
 * self-contained wrapper if the letterhead is disabled or unset. `content` and
 * `logo` are injected as raw HTML; the text slots are escaped.
 */
export async function wrapInLetterhead(contentHtml: string, ctx: WrapContext): Promise<string> {
  const row = await prisma.letterhead.findUnique({ where: { id: 1 } });
  const design = row?.enabled === false ? null : row?.html || DEFAULT_LETTERHEAD;

  if (!design) {
    return `<div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:1.7;color:#374151;">${contentHtml}</div>`;
  }
  const logoHtml = await buildLogoHtml(ctx.company_name);
  // Inject raw HTML slots first, then fill the escaped text slots.
  const withRaw = design
    .replace(/\{\{\s*content\s*\}\}/gi, contentHtml)
    .replace(/\{\{\s*logo\s*\}\}/gi, logoHtml);
  // {{title}} normalizes to `quote_title` via the alias map.
  const renderCtx = {
    quote_title: ctx.title,
    company_name: ctx.company_name,
    date: ctx.date,
  };
  return renderTemplate(withRaw, renderCtx, { escape: true });
}
