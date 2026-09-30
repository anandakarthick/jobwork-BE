import { readFile } from 'fs/promises';
import type { Prisma } from '@prisma/client';
import { prisma } from '../../lib/prisma';
import { HttpError } from '../../lib/http-error';
import { env } from '../../config/env';
import { buildQuoteXlsx } from '../quote/quote.service';
import { getAppSettings } from '../settings/settings.service';
import { sendMail } from './email.mailer';
import type { RenderContext } from './email.render';
import { wrapInLetterhead } from './letterhead';
import type { ListLogsQuery, SendQuoteEmailInput } from './email.schema';

// ---------------------------------------------------------------------------
// Quote → email context + prefill
// ---------------------------------------------------------------------------

const inr = new Intl.NumberFormat('en-IN', { maximumFractionDigits: 0 });

function formatDate(d: Date): string {
  const dd = String(d.getDate()).padStart(2, '0');
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  return `${dd}.${mm}.${d.getFullYear()}`;
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** Convert a plain-text message to safe HTML paragraphs (blank line = new <p>). */
function textToHtml(text: string): string {
  return text
    .trim()
    .split(/\n{2,}/)
    .map((para) => `<p style="margin:0 0 14px 0;">${escapeHtml(para).replace(/\n/g, '<br>')}</p>`)
    .join('');
}

/** Build the placeholder values for a quote (customer, product, total, …). */
async function buildQuoteContext(
  quoteId: number,
  senderId: number,
): Promise<{ context: RenderContext; to: string; customerName: string; product: string | null }> {
  const quote = await prisma.quote.findUnique({
    where: { id: quoteId },
    include: {
      customer: { select: { name: true, email: true } },
      category: { select: { name: true } },
      lines: { select: { amount: true } },
    },
  });
  if (!quote) throw HttpError.notFound('Quote not found');

  const total = quote.lines.reduce((sum, l) => sum + (l.amount ? Number(l.amount) : 0), 0);
  const [app, sender] = await Promise.all([
    getAppSettings(),
    prisma.user.findUnique({ where: { id: senderId }, select: { name: true } }),
  ]);
  const senderName = sender?.name ?? '';

  const context: RenderContext = {
    recipient_name: quote.customer.name,
    recipient_email: quote.customer.email ?? '',
    product: quote.category?.name ?? '',
    brand: quote.brand ?? '',
    quote_title: quote.title ?? quote.category?.name ?? 'Quotation',
    quote_number: `Q-${String(quote.id).padStart(6, '0')}`,
    total: `₹${inr.format(total)}`,
    line_count: String(quote.lines.length),
    date: formatDate(new Date()),
    sender_name: senderName || app.appName,
    sender_title: '',
    company_name: app.appName,
  };

  return {
    context,
    to: quote.customer.email ?? '',
    customerName: quote.customer.name,
    product: quote.category?.name ?? null,
  };
}

/**
 * Prefill the quote compose form: recipient, subject, and a plain-text message.
 * The message is what the user edits; at send time it's dropped into the
 * letter-pad design (no content templates involved).
 */
export async function getQuotePrefill(quoteId: number, senderId: number) {
  const { context, to, customerName, product } = await buildQuoteContext(quoteId, senderId);
  const subject = `Quotation${product ? ` — ${product}` : ''} for ${customerName}`;
  const message =
    `Dear ${customerName},\n\n` +
    `Thank you for your enquiry. Please find attached our quotation ` +
    `${context.quote_number}${product ? ` for ${product}` : ''}` +
    `${context.brand ? ` (${context.brand})` : ''}. The total value is ${context.total} ` +
    `for ${context.line_count} line item(s).\n\n` +
    `Please let us know if you have any questions or require changes.\n\n` +
    `Best regards,\n${context.sender_name}`;

  return { to, subject, message };
}

// ---------------------------------------------------------------------------
// Send
// ---------------------------------------------------------------------------

export async function sendQuoteEmail(input: SendQuoteEmailInput, userId: number) {
  // Confirm the quote exists and gather the letter-pad context.
  const { context } = await buildQuoteContext(input.quoteId, userId);

  const attachments: { filename: string; content: Buffer; contentType?: string }[] = [];

  // 1) The generated quote spreadsheet.
  if (input.attachQuote) {
    const { buffer, fileName } = await buildQuoteXlsx(input.quoteId);
    attachments.push({
      filename: fileName,
      content: buffer,
      contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    });
  }

  // 2) Any selected uploaded input documents (must belong to this quote).
  if (input.documentIds.length) {
    const docs = await prisma.quoteDocument.findMany({
      where: { id: { in: input.documentIds }, quoteId: input.quoteId },
    });
    for (const d of docs) {
      try {
        attachments.push({
          filename: d.fileName,
          content: await readFile(d.storagePath),
          contentType: d.mimeType,
        });
      } catch {
        throw HttpError.badRequest(`Could not read the attached file "${d.fileName}".`);
      }
    }
  }

  // Drop the typed message into the letter-pad design.
  const html = await wrapInLetterhead(textToHtml(input.message), {
    title: 'Quotation',
    company_name: context.company_name ?? '',
    date: context.date ?? '',
  });

  let status = 'SENT';
  let error: string | null = null;
  try {
    await sendMail({
      to: input.to,
      subject: input.subject,
      html,
      text: input.message,
      attachments,
    });
  } catch (err) {
    status = 'FAILED';
    error = err instanceof Error ? err.message : 'Send failed';
  }

  const log = await prisma.emailLog.create({
    data: {
      quoteId: input.quoteId,
      toEmail: input.to.join(', '),
      subject: input.subject,
      body: input.message,
      hasAttachment: attachments.length > 0,
      status,
      error,
      sentById: userId,
    },
  });

  if (status === 'FAILED') {
    throw HttpError.badRequest(`Email could not be sent: ${error ?? 'unknown error'}`);
  }
  return log;
}

export async function listLogs(query: ListLogsQuery) {
  const where: Prisma.EmailLogWhereInput = query.quoteId ? { quoteId: query.quoteId } : {};
  const [rows, total] = await Promise.all([
    prisma.emailLog.findMany({
      where,
      include: {
        sentBy: { select: { id: true, name: true } },
        quote: { select: { id: true, title: true } },
      },
      orderBy: { createdAt: 'desc' },
      skip: (query.page - 1) * query.limit,
      take: query.limit,
    }),
    prisma.emailLog.count({ where }),
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

// ---------------------------------------------------------------------------
// Test email (verify SMTP config)
// ---------------------------------------------------------------------------

/** Send a test message (on the active letter pad) to confirm SMTP works. */
export async function sendTestEmail(to: string) {
  const app = await getAppSettings();
  const text =
    `This is a test email from ${app.appName}.\n\n` +
    `If you received this, your outgoing email (SMTP) settings are configured correctly, ` +
    `and this is the email template currently in use.\n\n` +
    `Sent at ${new Date().toLocaleString()}.`;

  const content =
    `<p style="margin:0 0 14px 0;">This is a test email from <strong>${escapeHtml(app.appName)}</strong>.</p>` +
    `<p style="margin:0 0 14px 0;">If you received this, your outgoing email (SMTP) settings are ` +
    `configured correctly — and this is the email template currently in use.</p>` +
    `<p style="margin:0;color:#059669;font-size:13px;">✓ SMTP test successful.</p>`;

  const html = await wrapInLetterhead(content, {
    title: 'SMTP Test Email',
    company_name: app.appName,
    date: formatDate(new Date()),
  });

  await sendMail({ to, subject: `${app.appName} — SMTP test email`, html, text });
  return { sent: true, to };
}

// ---------------------------------------------------------------------------
// New-user credentials email
// ---------------------------------------------------------------------------

/** The login URL the credentials email points new users at. */
function loginUrl(): string {
  const base = env.corsOrigin[0]?.replace(/\/+$/, '') || 'http://localhost:5175';
  return `${base}/login`;
}

/**
 * Email a freshly-created user their login credentials. Best-effort: never
 * throws — returns {sent,error} so user creation isn't blocked when SMTP is
 * unconfigured or the send fails. The attempt is recorded in the email log.
 */
export async function sendUserCredentials(params: {
  to: string;
  name: string;
  password: string;
  roleName: string | null;
  createdById?: number;
}): Promise<{ sent: boolean; error: string | null }> {
  const app = await getAppSettings();
  const subject = `Your ${app.appName} account`;
  const url = loginUrl();

  // Plain-text version (also the audit body, with the password masked below).
  const text =
    `Hello ${params.name},\n\n` +
    `An account has been created for you on ${app.appName}.\n\n` +
    `You can sign in here: ${url}\n\n` +
    `Email: ${params.to}\n` +
    `Password: ${params.password}\n` +
    (params.roleName ? `Role: ${params.roleName}\n` : '') +
    `\nFor your security, please sign in and change your password as soon as possible.\n\n` +
    `Regards,\n${app.appName}`;

  // The credential details, laid out on the letter pad.
  const content =
    `<p style="margin:0 0 14px 0;">Hello ${escapeHtml(params.name)},</p>` +
    `<p style="margin:0 0 14px 0;">An account has been created for you on <strong>${escapeHtml(
      app.appName,
    )}</strong>. Use the details below to sign in.</p>` +
    `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:0 0 16px 0;font-size:14px;border:1px solid #e5e7eb;border-radius:8px;overflow:hidden;">` +
    `<tr><td style="padding:8px 16px;background:#f8fafc;color:#6b7280;">Login</td><td style="padding:8px 16px;"><a href="${escapeHtml(
      url,
    )}" style="color:#2563eb;">${escapeHtml(url)}</a></td></tr>` +
    `<tr><td style="padding:8px 16px;background:#f8fafc;color:#6b7280;">Email</td><td style="padding:8px 16px;font-weight:bold;">${escapeHtml(
      params.to,
    )}</td></tr>` +
    `<tr><td style="padding:8px 16px;background:#f8fafc;color:#6b7280;">Password</td><td style="padding:8px 16px;font-weight:bold;font-family:monospace;">${escapeHtml(
      params.password,
    )}</td></tr>` +
    (params.roleName
      ? `<tr><td style="padding:8px 16px;background:#f8fafc;color:#6b7280;">Role</td><td style="padding:8px 16px;">${escapeHtml(
          params.roleName,
        )}</td></tr>`
      : '') +
    `</table>` +
    `<p style="margin:0;color:#b45309;font-size:13px;">For your security, please sign in and change your password as soon as possible.</p>`;

  const html = await wrapInLetterhead(content, {
    title: `Welcome to ${app.appName}`,
    company_name: app.appName,
    date: formatDate(new Date()),
  });

  let status = 'SENT';
  let error: string | null = null;
  try {
    await sendMail({ to: params.to, subject, html, text });
  } catch (err) {
    status = 'FAILED';
    error = err instanceof Error ? err.message : 'Send failed';
  }

  // Audit — but never store the plaintext password in the log body.
  await prisma.emailLog
    .create({
      data: {
        toEmail: params.to,
        subject,
        body: text.replace(params.password, '••••••••'),
        hasAttachment: false,
        status,
        error,
        sentById: params.createdById ?? null,
      },
    })
    .catch(() => {
      /* logging must not break creation */
    });

  return { sent: status === 'SENT', error };
}

// ---------------------------------------------------------------------------
// Password-reset LINK email (magic link)
// ---------------------------------------------------------------------------

/** Email a secure reset LINK (magic link) on the letter pad. Best-effort. */
export async function sendPasswordResetLink(params: {
  to: string;
  name: string;
  url: string;
  minutes: number;
}): Promise<{ sent: boolean; error: string | null }> {
  const app = await getAppSettings();
  const subject = `${app.appName} — reset your password`;
  const text =
    `Hello ${params.name},\n\n` +
    `We received a request to reset your ${app.appName} password.\n\n` +
    `Reset it here (link expires in ${params.minutes} minutes):\n${params.url}\n\n` +
    `If you didn't request this, you can safely ignore this email.`;

  const content =
    `<p style="margin:0 0 14px 0;">Hello ${escapeHtml(params.name)},</p>` +
    `<p style="margin:0 0 18px 0;">We received a request to reset your ${escapeHtml(
      app.appName,
    )} password. Click the button below to choose a new one.</p>` +
    `<div style="margin:0 0 18px 0;text-align:center;">` +
    `<a href="${params.url}" style="display:inline-block;padding:12px 28px;background:#4f46e5;color:#ffffff;font-size:15px;font-weight:bold;text-decoration:none;border-radius:8px;">Reset my password</a>` +
    `</div>` +
    `<p style="margin:0 0 8px 0;color:#6b7280;font-size:13px;">Or paste this link into your browser:</p>` +
    `<p style="margin:0 0 14px 0;word-break:break-all;"><a href="${params.url}" style="color:#2563eb;font-size:13px;">${escapeHtml(
      params.url,
    )}</a></p>` +
    `<p style="margin:0 0 14px 0;color:#6b7280;font-size:13px;">This link expires in ${params.minutes} minutes and can be used once.</p>` +
    `<p style="margin:0;color:#b45309;font-size:13px;">If you didn't request a password reset, you can safely ignore this email.</p>`;

  const html = await wrapInLetterhead(content, {
    title: 'Reset Your Password',
    company_name: app.appName,
    date: formatDate(new Date()),
  });

  let status = 'SENT';
  let error: string | null = null;
  try {
    await sendMail({ to: params.to, subject, html, text });
  } catch (err) {
    status = 'FAILED';
    error = err instanceof Error ? err.message : 'Send failed';
  }

  // Audit — store the link without the token query so it isn't reusable from logs.
  await prisma.emailLog
    .create({
      data: {
        toEmail: params.to,
        subject,
        body: text.replace(/token=[^\s]+/g, 'token=•••'),
        hasAttachment: false,
        status,
        error,
      },
    })
    .catch(() => {
      /* logging must not break the flow */
    });

  return { sent: status === 'SENT', error };
}
