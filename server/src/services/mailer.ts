import nodemailer, { type Transporter } from 'nodemailer';
import { env } from '../config/env.js';
import { logger } from '../logger.js';

export interface Mail {
  to: string;
  subject: string;
  text: string;
  html?: string;
  attachments?: Array<{ filename: string; content: string; contentType: string }>;
}

let transport: Transporter | null = null;
let sent: Mail[] | null = null;

export function mailConfigured(): boolean {
  return !!env.SMTP_URL || sent !== null;
}

/**
 * Sends email through SMTP_URL (e.g. smtps://user:pass@smtp.resend.com:465).
 * Without SMTP in development the message is logged so links can still be used.
 */
export async function sendMail(mail: Mail): Promise<boolean> {
  if (sent) {
    sent.push(mail);
    return true;
  }
  if (!env.SMTP_URL) {
    if (env.NODE_ENV !== 'production') {
      logger.info({ to: mail.to, subject: mail.subject, text: mail.text }, 'email (SMTP not configured – logged instead)');
    } else {
      logger.warn({ subject: mail.subject }, 'email not sent: SMTP_URL is not configured');
    }
    return false;
  }
  transport ??= nodemailer.createTransport(env.SMTP_URL);
  await transport.sendMail({ from: env.MAIL_FROM, ...mail });
  return true;
}

/** Tests only: capture mail instead of sending. */
export function captureMailForTests(): Mail[] {
  sent = [];
  return sent;
}

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

/** Minimal branded wrapper so emails look like AuMeet, in plain HTML that every client renders. */
export function emailHtml(title: string, bodyHtml: string, cta?: { label: string; url: string }): string {
  const button = cta
    ? `<p style="margin:28px 0"><a href="${escapeHtml(cta.url)}" style="background:#ffffff;color:#000000;padding:12px 22px;text-decoration:none;font-weight:600;display:inline-block">${escapeHtml(cta.label)}</a></p>`
    : '';
  return `<!doctype html><html><body style="margin:0;background:#000;font-family:Inter,Segoe UI,Arial,sans-serif;color:#ededed">
<table width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:32px 16px">
<table width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;background:#1a1a1a;border:1px solid #2a2a2a">
<tr><td style="padding:32px">
<p style="margin:0 0 20px;color:#3df2b1;font-weight:700;letter-spacing:.02em">AuMeet</p>
<h1 style="margin:0 0 16px;font-size:22px;color:#ffffff">${escapeHtml(title)}</h1>
<div style="font-size:15px;line-height:1.6;color:#cfcfcf">${bodyHtml}</div>${button}
</td></tr></table></td></tr></table></body></html>`;
}
