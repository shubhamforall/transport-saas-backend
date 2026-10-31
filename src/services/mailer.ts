import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import nodemailer, { type Transporter } from 'nodemailer';
import { env, isProduction } from '../config/env.js';
import { logger } from '../utils/logger.js';

export interface MailMessage {
  to: string;
  cc?: string[];
  subject: string;
  text: string;
  html?: string;
  attachments?: { filename: string; content: Buffer; contentType: string }[];
}

export interface SentMail {
  messageId: string | null;
}

/** Messages "sent" during tests, for assertions. */
export const testOutbox: MailMessage[] = [];

let transporter: Transporter | null = null;

function smtpConfigured() {
  return Boolean(env.SMTP_HOST && env.SMTP_FROM_EMAIL);
}

export function emailConfigured() {
  return smtpConfigured() || !isProduction;
}

function getTransport(): Transporter {
  transporter ??= nodemailer.createTransport({
    host: env.SMTP_HOST,
    port: env.SMTP_PORT,
    secure: env.SMTP_SECURE,
    auth: env.SMTP_USER ? { user: env.SMTP_USER, pass: env.SMTP_PASSWORD } : undefined,
    // Hosting request timeouts are short; fail fast instead of hanging the request.
    connectionTimeout: 10_000,
    greetingTimeout: 10_000,
    socketTimeout: 20_000,
  });
  return transporter;
}

export class MailError extends Error {
  constructor(public readonly safeMessage: string) {
    super(safeMessage);
  }
}

/** Turns transport errors into a short message that is safe to store and show. */
function safeReason(err: unknown): string {
  const code = (err as { code?: string; responseCode?: number })?.code;
  const responseCode = (err as { responseCode?: number })?.responseCode;
  if (code === 'ETIMEDOUT' || code === 'ECONNECTION' || code === 'ESOCKET') {
    return 'Could not connect to the email server. Try again later.';
  }
  if (code === 'EAUTH') return 'Email server rejected the login. Check SMTP settings.';
  if (code === 'EENVELOPE' || (responseCode && responseCode >= 550)) {
    return 'The recipient address was rejected.';
  }
  return 'Email could not be sent. Try again later.';
}

/**
 * Sends an email. Without SMTP settings: tests collect messages in memory and development
 * writes .eml files to tmp/outbox so they can be opened locally.
 */
export async function sendMail(msg: MailMessage): Promise<SentMail> {
  if (env.NODE_ENV === 'test') {
    testOutbox.push(msg);
    return { messageId: `test-${testOutbox.length}` };
  }
  if (!smtpConfigured()) {
    if (isProduction) throw new MailError('Email is not configured on this server.');
    const preview = nodemailer.createTransport({ streamTransport: true, buffer: true });
    const info = await preview.sendMail({
      from: `"${env.SMTP_FROM_NAME}" <no-reply@vaharo.local>`,
      ...msg,
    });
    const dir = join(process.cwd(), 'tmp', 'outbox');
    mkdirSync(dir, { recursive: true });
    const file = join(dir, `${Date.now()}-${msg.to.replace(/[^a-z0-9@.]/gi, '_')}.eml`);
    writeFileSync(file, info.message as Buffer);
    logger.info({ file }, 'SMTP not configured: email saved to outbox');
    return { messageId: info.messageId ?? null };
  }
  try {
    const info = await getTransport().sendMail({
      from: `"${env.SMTP_FROM_NAME}" <${env.SMTP_FROM_EMAIL}>`,
      ...msg,
    });
    return { messageId: info.messageId ?? null };
  } catch (err) {
    // Log the code only; SMTP responses can echo credentials or addresses.
    logger.warn({ code: (err as { code?: string })?.code }, 'Email send failed');
    throw new MailError(safeReason(err));
  }
}

export function escapeHtml(s: string): string {
  return s.replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!,
  );
}

/** Minimal branded HTML wrapper; paragraphs are escaped. */
export function simpleHtml(paragraphs: string[], button?: { label: string; url: string }) {
  const body = paragraphs
    .map((p) => `<p style="margin:0 0 14px">${escapeHtml(p).replace(/\n/g, '<br>')}</p>`)
    .join('');
  const cta = button
    ? `<p style="margin:22px 0"><a href="${escapeHtml(button.url)}" style="background:#2563eb;color:#fff;padding:11px 18px;border-radius:8px;text-decoration:none;font-weight:600">${escapeHtml(button.label)}</a></p>`
    : '';
  return `<div style="font-family:Segoe UI,Arial,sans-serif;color:#172033;font-size:14px;line-height:1.55;max-width:560px">${body}${cta}<p style="color:#64748b;font-size:12px;margin-top:28px">Sent with Vaharo</p></div>`;
}
