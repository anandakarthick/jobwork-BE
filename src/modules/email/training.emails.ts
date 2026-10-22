/**
 * Training notification emails — brand price-list files trained into Claude.
 *
 * One email per event. Recipients come from Settings → Notifications: a fixed
 * list of addresses and/or the user who clicked Train (fallback: the uploader).
 * Each event can be switched off there, and the whole thing has a master switch.
 *   - STARTED    – the file has been queued / is being read
 *   - COMPLETED  – uploaded to Claude (and, when page search is on, indexed)
 *   - FAILED     – extraction, upload or (as a warning) the page-search index failed
 *
 * Every email is laid out on the configured letter pad (Settings → Email
 * Template) like the other system emails, and recorded in email_logs.
 * Best-effort: a mail problem is logged and never breaks the training itself.
 */
import { prisma } from '../../lib/prisma';
import { env } from '../../config/env';
import { getAppSettings, getNotificationSettings } from '../settings/settings.service';
import { sendMail } from './email.mailer';
import { wrapInLetterhead } from './letterhead';

export type TrainingEvent = 'STARTED' | 'COMPLETED' | 'FAILED';

export interface TrainingEmailInput {
  event: TrainingEvent;
  document: {
    id: number;
    companyId: number | null;
    brand: string | null;
    name: string | null;
    fileName: string;
    createdById: number;
  };
  /** The user who started the training (recipient). Falls back to the uploader. */
  userId?: number | null;
  startedAt?: Date;
  finishedAt?: Date;
  /** Result details (COMPLETED, or FAILED after a partial success). */
  pages?: number | null;
  chars?: number | null;
  ocrPages?: number;
  ocrImages?: number;
  index?: { pages: number; chunks: number } | null;
  /** FAILED: what went wrong. */
  error?: string;
  /** FAILED with `warning: true` = the training itself succeeded; only a follow-up step failed. */
  warning?: boolean;
}

const COLOURS: Record<TrainingEvent, { bg: string; fg: string; border: string; label: string }> = {
  STARTED: { bg: '#eff6ff', fg: '#1d4ed8', border: '#bfdbfe', label: 'Training started' },
  COMPLETED: { bg: '#ecfdf5', fg: '#047857', border: '#a7f3d0', label: 'Training completed' },
  FAILED: { bg: '#fef2f2', fg: '#b91c1c', border: '#fecaca', label: 'Training failed' },
};
const WARNING = { bg: '#fffbeb', fg: '#b45309', border: '#fde68a', label: 'Training completed with a warning' };

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function formatDate(d: Date): string {
  const dd = String(d.getDate()).padStart(2, '0');
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  return `${dd}.${mm}.${d.getFullYear()}`;
}

function formatDateTime(d: Date): string {
  const hh = String(d.getHours()).padStart(2, '0');
  const mi = String(d.getMinutes()).padStart(2, '0');
  const ss = String(d.getSeconds()).padStart(2, '0');
  return `${formatDate(d)} ${hh}:${mi}:${ss}`;
}

function formatDuration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60);
  const rest = s % 60;
  if (m < 60) return rest ? `${m} min ${rest} s` : `${m} min`;
  const h = Math.floor(m / 60);
  return `${h} h ${m % 60} min`;
}

const num = new Intl.NumberFormat('en-IN');

/** The brand page in the web app (first CORS origin = the frontend). */
function brandUrl(companyId: number | null): string | null {
  if (!companyId) return null;
  const base = env.corsOrigin[0]?.replace(/\/+$/, '');
  return base ? `${base}/companies/${companyId}` : null;
}

interface Recipients {
  /** Every address the email goes to (unique, lower-case). */
  to: string[];
  /** The user who started the training (for "Started by" and the greeting), if known. */
  starter: { id: number; name: string; email: string } | null;
}

/** The user who clicked Train, else the uploader (null when neither exists / is active). */
async function starterFor(input: TrainingEmailInput): Promise<Recipients['starter']> {
  const ids = [input.userId, input.document.createdById].filter((v): v is number => typeof v === 'number' && v > 0);
  for (const id of ids) {
    const user = await prisma.user.findUnique({ where: { id }, select: { id: true, name: true, email: true, isActive: true } });
    if (user?.email && user.isActive) return { id: user.id, name: user.name, email: user.email };
  }
  return null;
}

/**
 * Recipients per Settings → Notifications. Returns null when the emails are
 * switched off, the event is switched off, or nobody would receive it.
 */
async function recipientsFor(input: TrainingEmailInput): Promise<Recipients | null> {
  const cfg = await getNotificationSettings();
  if (!cfg.trainingEnabled) return null;
  const eventOn =
    input.event === 'STARTED' ? cfg.trainingOnStarted : input.event === 'COMPLETED' ? cfg.trainingOnCompleted : cfg.trainingOnFailed;
  if (!eventOn) return null;

  const starter = await starterFor(input);
  const to = new Set(cfg.trainingRecipients);
  if (cfg.trainingNotifyStarter && starter) to.add(starter.email.toLowerCase());
  if (!to.size) return null;
  return { to: [...to], starter };
}

/** Status band + details table + brand link, laid out for the letter pad. */
function buildTemplate(input: TrainingEmailInput, starterName: string, appName: string, greeting = starterName) {
  const isWarning = input.event === 'FAILED' && input.warning;
  const c = isWarning ? WARNING : COLOURS[input.event];
  const fileLabel = input.document.name ? `${input.document.name} (${input.document.fileName})` : input.document.fileName;
  const brand = input.document.brand ?? '';
  const link = brandUrl(input.document.companyId);
  const duration =
    input.startedAt && input.finishedAt ? formatDuration(input.finishedAt.getTime() - input.startedAt.getTime()) : null;

  // ---- Lead sentence per event
  let lead: string;
  let subject: string;
  switch (input.event) {
    case 'STARTED':
      subject = `[${appName}] Training started — ${brand}: ${fileLabel}`;
      lead =
        `Training of the ${brand} price list <strong>${escapeHtml(fileLabel)}</strong> has started. ` +
        `The file is being read (including OCR of any scanned pages) and uploaded to Claude. ` +
        `You will receive another email when it finishes or if anything fails.`;
      break;
    case 'COMPLETED':
      subject = `[${appName}] Training completed — ${brand}: ${fileLabel}`;
      lead =
        `The ${brand} price list <strong>${escapeHtml(fileLabel)}</strong> has been trained successfully. ` +
        `Quotes for ${escapeHtml(brand)} will use this file from now on.`;
      break;
    case 'FAILED':
    default:
      subject = isWarning
        ? `[${appName}] Training completed with a warning — ${brand}: ${fileLabel}`
        : `[${appName}] Training FAILED — ${brand}: ${fileLabel}`;
      lead = isWarning
        ? `The ${brand} price list <strong>${escapeHtml(fileLabel)}</strong> was trained into Claude, ` +
          `but a follow-up step failed. Quotes still work; they will attach the whole file instead of ` +
          `only the matching pages until the file is trained again.`
        : `Training of the ${brand} price list <strong>${escapeHtml(fileLabel)}</strong> did not complete. ` +
          `The file is NOT available to quotes. Please check the reason below and train it again.`;
      break;
  }

  // ---- Details rows
  const rows: [string, string][] = [
    ['Brand', brand],
    ['File', fileLabel],
    ['Started by', starterName],
  ];
  if (input.startedAt) rows.push(['Started at', formatDateTime(input.startedAt)]);
  if (input.finishedAt) rows.push([input.event === 'COMPLETED' || isWarning ? 'Finished at' : 'Failed at', formatDateTime(input.finishedAt)]);
  if (duration) rows.push(['Duration', duration]);
  if (input.pages != null) rows.push(['Pages', num.format(input.pages)]);
  if (input.chars != null) rows.push(['Text extracted', `${num.format(input.chars)} characters`]);
  if (input.ocrPages || input.ocrImages)
    rows.push(['OCR', `${num.format(input.ocrPages ?? 0)} scanned page(s), ${num.format(input.ocrImages ?? 0)} embedded image(s)`]);
  if (input.index) rows.push(['Page-search index', `${num.format(input.index.pages)} pages, ${num.format(input.index.chunks)} chunks`]);
  else if (input.index === null) rows.push(['Page-search index', 'not enabled on this server']);

  const table =
    `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:0 0 16px 0;font-size:14px;border:1px solid #e5e7eb;border-radius:8px;overflow:hidden;width:100%;">` +
    rows
      .map(
        ([k, v]) =>
          `<tr><td style="padding:8px 16px;background:#f8fafc;color:#6b7280;white-space:nowrap;width:150px;">${escapeHtml(k)}</td>` +
          `<td style="padding:8px 16px;">${escapeHtml(v)}</td></tr>`,
      )
      .join('') +
    `</table>`;

  const badge =
    `<div style="margin:0 0 16px 0;padding:10px 14px;border:1px solid ${c.border};background:${c.bg};color:${c.fg};` +
    `border-radius:8px;font-weight:bold;font-size:14px;">${escapeHtml(c.label)}</div>`;

  const errorBox = input.error
    ? `<p style="margin:0 0 6px 0;color:#6b7280;font-size:13px;">${isWarning ? 'Warning' : 'Reason'}</p>` +
      `<pre style="margin:0 0 16px 0;padding:12px 14px;background:#fef2f2;border:1px solid #fecaca;border-radius:8px;` +
      `color:#7f1d1d;font-size:13px;white-space:pre-wrap;word-break:break-word;font-family:Consolas,Menlo,monospace;">` +
      `${escapeHtml(input.error)}</pre>`
    : '';

  const button = link
    ? `<div style="margin:4px 0 16px 0;text-align:center;">` +
      `<a href="${escapeHtml(link)}" style="display:inline-block;padding:11px 26px;background:#4f46e5;color:#ffffff;font-size:14px;` +
      `font-weight:bold;text-decoration:none;border-radius:8px;">Open brand ${escapeHtml(brand)}</a></div>`
    : '';

  const hint =
    input.event === 'STARTED'
      ? `<p style="margin:0;color:#6b7280;font-size:13px;">Large catalogues can take several minutes. You can keep working; the brand page shows the live status.</p>`
      : input.event === 'COMPLETED'
        ? `<p style="margin:0;color:#6b7280;font-size:13px;">To update the file later, upload the new version on the brand page and click Train again.</p>`
        : isWarning
          ? `<p style="margin:0;color:#6b7280;font-size:13px;">Click <strong>Train again</strong> on the brand page once the problem is fixed to rebuild the index.</p>`
          : `<p style="margin:0;color:#b45309;font-size:13px;">If the reason mentions the API key, check Settings → API Keys. Otherwise fix the file and click Train again.</p>`;

  const content =
    `<p style="margin:0 0 14px 0;">Hello ${escapeHtml(greeting)},</p>` +
    badge +
    `<p style="margin:0 0 16px 0;">${lead}</p>` +
    table +
    errorBox +
    button +
    hint;

  // Plain-text twin (also the audit body in email_logs).
  const text =
    `Hello ${greeting},\n\n` +
    `${c.label.toUpperCase()}\n\n` +
    lead.replace(/<[^>]+>/g, '') +
    `\n\n` +
    rows.map(([k, v]) => `${k}: ${v}`).join('\n') +
    (input.error ? `\n\n${isWarning ? 'Warning' : 'Reason'}:\n${input.error}` : '') +
    (link ? `\n\nOpen the brand: ${link}` : '') +
    `\n\nRegards,\n${appName}`;

  return { subject, title: c.label, content, text };
}

/** Render one notification (subject, letter-pad HTML, plain text) without sending — previews / tests. */
export async function renderTrainingEmail(input: TrainingEmailInput, starterName = 'there', greeting = starterName) {
  const app = await getAppSettings();
  const tpl = buildTemplate(input, starterName, app.appName, greeting);
  const html = await wrapInLetterhead(tpl.content, { title: tpl.title, company_name: app.appName, date: formatDate(new Date()) });
  return { subject: tpl.subject, html, text: tpl.text };
}

/** Deliver one rendered email to the recipients and record it in email_logs. */
async function deliver(to: string[], tpl: { subject: string; html: string; text: string }, sentById: number | null) {
  let status = 'SENT';
  let error: string | null = null;
  try {
    await sendMail({ to, subject: tpl.subject, html: tpl.html, text: tpl.text });
  } catch (err) {
    status = 'FAILED';
    error = err instanceof Error ? err.message : 'Send failed';
  }
  await prisma.emailLog
    .create({
      data: { toEmail: to.join(', ').slice(0, 190), subject: tpl.subject, body: tpl.text, hasAttachment: false, status, error, sentById },
    })
    .catch(() => {
      /* logging must not break training */
    });
  return { sent: status === 'SENT', error };
}

/**
 * Settings → Notifications → "Send sample": a sample "Training completed" email
 * to the SAVED recipients plus the caller, so the list can be verified.
 */
export async function sendTrainingSample(callerId: number): Promise<{ sent: boolean; to: string[]; error: string | null }> {
  const cfg = await getNotificationSettings();
  const caller = await prisma.user.findUnique({ where: { id: callerId }, select: { id: true, name: true, email: true } });
  const to = [...new Set([...cfg.trainingRecipients, ...(caller?.email ? [caller.email.toLowerCase()] : [])])];
  if (!to.length) return { sent: false, to, error: 'No recipients' };
  const now = new Date();
  const tpl = await renderTrainingEmail(
    {
      event: 'COMPLETED',
      document: { id: 0, companyId: null, brand: 'SAMPLE', name: 'Sample price list', fileName: 'sample-price-list.pdf', createdById: callerId },
      userId: callerId,
      startedAt: new Date(now.getTime() - 6 * 60_000),
      finishedAt: now,
      pages: 120,
      chars: 350_000,
      index: { pages: 120, chunks: 400 },
    },
    caller?.name ?? 'Admin',
    to.length === 1 && caller ? caller.name : 'team',
  );
  const r = await deliver(to, { ...tpl, subject: `${tpl.subject} (sample)` }, callerId);
  return { ...r, to };
}

/**
 * Send one training notification. Never throws; returns whether it went out.
 * Skipped silently when no recipient with an email can be found.
 */
export async function sendTrainingEmail(input: TrainingEmailInput): Promise<{ sent: boolean; error: string | null }> {
  try {
    const recipients = await recipientsFor(input);
    if (!recipients) return { sent: false, error: 'No recipient / switched off' };
    const starterName = recipients.starter?.name ?? 'unknown';
    // Greet the starter by name when the mail goes only to them; otherwise the team.
    const onlyStarter = recipients.starter && recipients.to.length === 1 && recipients.to[0] === recipients.starter.email.toLowerCase();
    const tpl = await renderTrainingEmail(input, starterName, onlyStarter ? starterName : 'team');
    const r = await deliver(recipients.to, tpl, recipients.starter?.id ?? null);
    if (!r.sent) console.warn(`[training-email] ${input.event} for document ${input.document.id} not sent:`, r.error);
    return r;
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    console.warn(`[training-email] ${input.event} for document ${input.document.id} skipped:`, message);
    return { sent: false, error: message };
  }
}
