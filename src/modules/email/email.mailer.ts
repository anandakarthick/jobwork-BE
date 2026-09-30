/**
 * Outbound mail via the admin-configured SMTP server (settings.smtp).
 *
 * The transport is built fresh from the DB row on each send so a settings
 * change takes effect immediately (sends are infrequent — no pooling needed).
 * The stored password stays server-side; it is never returned to the client.
 */
import nodemailer from 'nodemailer';
import { prisma } from '../../lib/prisma';
import { HttpError } from '../../lib/http-error';

export interface Attachment {
  filename: string;
  content: Buffer;
  contentType?: string;
}

export interface SendMailInput {
  to: string | string[];
  cc?: string[];
  subject: string;
  /** Plain-text body. When `html` is omitted it is also wrapped as simple HTML. */
  text?: string;
  /** Pre-built HTML body (e.g. a styled letterhead template). Sent as-is. */
  html?: string;
  attachments?: Attachment[];
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/** Rough plain-text fallback from an HTML body (for non-HTML mail clients). */
function htmlToText(html: string): string {
  return html
    .replace(/<\s*(br|\/p|\/div|\/tr|\/h[1-6])\s*>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** Build a nodemailer transport from the stored SMTP settings (throws if unset). */
async function buildTransport() {
  const smtp = await prisma.smtpSetting.findUnique({ where: { id: 1 } });
  if (!smtp?.host || !smtp.fromEmail) {
    throw HttpError.badRequest(
      'Email is not configured. Set the SMTP server and sender address in Settings → Email (SMTP) first.',
    );
  }
  const transport = nodemailer.createTransport({
    host: smtp.host,
    port: smtp.port,
    secure: smtp.secure,
    auth: smtp.username ? { user: smtp.username, pass: smtp.password ?? '' } : undefined,
  });
  const from = smtp.fromName ? `"${smtp.fromName}" <${smtp.fromEmail}>` : smtp.fromEmail;
  return { transport, from };
}

/** Send one email. Returns nodemailer's messageId on success. */
export async function sendMail(input: SendMailInput): Promise<string> {
  const { transport, from } = await buildTransport();

  // Resolve the HTML + plain-text parts. A pre-built HTML body is sent as-is
  // (with a stripped text fallback); otherwise the plain text is wrapped.
  const html = input.html
    ? input.html
    : `<div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;color:#1f2937;white-space:pre-wrap">${escapeHtml(
        input.text ?? '',
      )}</div>`;
  const text = input.text ?? (input.html ? htmlToText(input.html) : '');

  const info = await transport.sendMail({
    from,
    to: input.to,
    cc: input.cc?.length ? input.cc : undefined,
    subject: input.subject,
    text,
    html,
    attachments: input.attachments,
  });
  return info.messageId;
}
