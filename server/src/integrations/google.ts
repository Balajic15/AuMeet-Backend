import { env } from '../config/env.js';
import { IntegrationModel } from '../models/Integration.js';
import { decryptSecret, encryptSecret } from '../services/secrets.js';
import { callJson, IntegrationError } from './errors.js';

/*
 * Gmail + Google Calendar with the same Google OAuth client used for sign-in, but a separate consent:
 *   gmail.send       – send follow-up emails as the user (cannot read their mail)
 *   calendar.events  – create events and invite attendees (cannot read other calendars)
 * Redirect URI to register in Google Cloud Console: <PUBLIC_API_URL>/api/integrations/google/callback
 */

export const GOOGLE_SCOPES = [
  'openid',
  'email',
  'https://www.googleapis.com/auth/gmail.send',
  'https://www.googleapis.com/auth/calendar.events',
];

interface GoogleSecret {
  refreshToken: string;
  accessToken: string;
  expiresAt: number;
}

export const googleConfigured = () => !!(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET);

export function googleCallbackUrl(): string {
  return `${env.PUBLIC_API_URL.replace(/\/$/, '')}/api/integrations/google/callback`;
}

export function googleAuthorizeUrl(state: string, loginHint?: string): string {
  const q = new URLSearchParams({
    client_id: env.GOOGLE_CLIENT_ID!,
    redirect_uri: googleCallbackUrl(),
    response_type: 'code',
    scope: GOOGLE_SCOPES.join(' '),
    access_type: 'offline', // a refresh token, so follow-ups can be sent after the user has left
    prompt: 'consent',
    include_granted_scopes: 'true',
    state,
    ...(loginHint ? { login_hint: loginHint } : {}),
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${q}`;
}

const form = (body: Record<string, string>): RequestInit => ({
  method: 'POST',
  headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
  body: new URLSearchParams(body),
});

/** Code → tokens → the account it belongs to. Saves (or replaces) the user's Google connection. */
export async function connectGoogle(userId: string, code: string): Promise<{ account: string; scopes: string[] }> {
  const tok = await callJson<{ access_token: string; refresh_token?: string; expires_in: number; scope: string }>(
    'https://oauth2.googleapis.com/token',
    form({ code, client_id: env.GOOGLE_CLIENT_ID!, client_secret: env.GOOGLE_CLIENT_SECRET!, redirect_uri: googleCallbackUrl(), grant_type: 'authorization_code' }),
    'Google',
  );
  const scopes = tok.scope.split(' ');
  const missing = GOOGLE_SCOPES.filter((s) => s.startsWith('https://') && !scopes.includes(s));
  if (missing.length) throw new IntegrationError('Please allow both Gmail sending and Calendar events', false);
  const existing = await IntegrationModel.findOne({ userId, provider: 'google' }).select('+secret');
  const refreshToken = tok.refresh_token ?? (existing?.secret ? decryptSecret<GoogleSecret>(existing.secret).refreshToken : '');
  if (!refreshToken) throw new IntegrationError('Google did not grant offline access; please try again', false);
  const me = await callJson<{ email?: string }>('https://openidconnect.googleapis.com/v1/userinfo', { headers: { Authorization: `Bearer ${tok.access_token}` } }, 'Google');
  const secret: GoogleSecret = { refreshToken, accessToken: tok.access_token, expiresAt: Date.now() + (tok.expires_in - 60) * 1000 };
  await IntegrationModel.updateOne(
    { userId, provider: 'google' },
    { $set: { status: 'connected', account: me.email ?? '', config: { scopes }, secret: encryptSecret(secret), enabled: true }, $unset: { lastError: 1 } },
    { upsert: true },
  );
  return { account: me.email ?? '', scopes };
}

/** A valid access token, refreshed when needed. Marks the connection broken if Google revoked it. */
async function accessToken(userId: string): Promise<{ token: string; account: string }> {
  const doc = await IntegrationModel.findOne({ userId, provider: 'google', enabled: true }).select('+secret');
  if (!doc) throw new IntegrationError('Google is not connected', false, true);
  const s = decryptSecret<GoogleSecret>(doc.secret);
  if (s.accessToken && s.expiresAt > Date.now()) return { token: s.accessToken, account: doc.account };
  try {
    const tok = await callJson<{ access_token: string; expires_in: number }>(
      'https://oauth2.googleapis.com/token',
      form({ client_id: env.GOOGLE_CLIENT_ID!, client_secret: env.GOOGLE_CLIENT_SECRET!, refresh_token: s.refreshToken, grant_type: 'refresh_token' }),
      'Google',
    );
    const next: GoogleSecret = { ...s, accessToken: tok.access_token, expiresAt: Date.now() + (tok.expires_in - 60) * 1000 };
    await IntegrationModel.updateOne({ _id: doc._id }, { $set: { secret: encryptSecret(next), status: 'connected' }, $unset: { lastError: 1 } });
    return { token: tok.access_token, account: doc.account };
  } catch (err) {
    const e = err instanceof IntegrationError ? err : new IntegrationError(String(err), true);
    // 400 invalid_grant = revoked or expired consent.
    if (!e.retryable) await IntegrationModel.updateOne({ _id: doc._id }, { $set: { status: 'error', lastError: 'Google access was revoked; please reconnect' } });
    throw new IntegrationError(e.message, e.retryable, !e.retryable);
  }
}

export async function googleReady(userId: string): Promise<boolean> {
  return !!(await IntegrationModel.exists({ userId, provider: 'google', enabled: true, status: 'connected' }));
}

const b64url = (s: string) => Buffer.from(s, 'utf8').toString('base64url');
const encodeHeader = (s: string) => (/^[\x20-\x7e]*$/.test(s) ? s.replace(/[\r\n]/g, ' ') : `=?UTF-8?B?${Buffer.from(s.replace(/[\r\n]/g, ' ')).toString('base64')}?=`);

/** RFC 5322 message (text + HTML) as Gmail wants it. Header values are stripped of line breaks. */
export function buildMime(m: { from: string; fromName?: string; to: string; subject: string; text: string; html?: string }): string {
  const boundary = `aumeet_${Math.random().toString(36).slice(2)}`;
  const addr = (a: string) => a.replace(/[\r\n<>]/g, '');
  const headers = [
    `From: ${m.fromName ? `${encodeHeader(m.fromName)} ` : ''}<${addr(m.from)}>`,
    `To: <${addr(m.to)}>`,
    `Subject: ${encodeHeader(m.subject)}`,
    'MIME-Version: 1.0',
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
  ];
  const part = (type: string, body: string) =>
    [`--${boundary}`, `Content-Type: ${type}; charset="UTF-8"`, 'Content-Transfer-Encoding: base64', '', Buffer.from(body, 'utf8').toString('base64')].join('\r\n');
  return [...headers, '', part('text/plain', m.text), ...(m.html ? [part('text/html', m.html)] : []), `--${boundary}--`, ''].join('\r\n');
}

/** Send as the connected user. Returns the Gmail message id. */
export async function sendGmail(userId: string, m: { fromName?: string; to: string; subject: string; text: string; html?: string }): Promise<string> {
  const { token, account } = await accessToken(userId);
  const out = await callJson<{ id: string }>(
    'https://gmail.googleapis.com/gmail/v1/users/me/messages/send',
    { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ raw: b64url(buildMime({ ...m, from: account })) }) },
    'Gmail',
  );
  await IntegrationModel.updateOne({ userId, provider: 'google' }, { $set: { lastUsedAt: new Date() } });
  return out.id;
}

/** One event in the user's primary calendar; Google emails the invitations. `eventId` makes retries idempotent. */
export async function createCalendarEvent(
  userId: string,
  e: { eventId: string; title: string; description: string; start: Date; minutes: number; attendees: string[] },
): Promise<{ id: string; link: string }> {
  const { token } = await accessToken(userId);
  const body = {
    id: e.eventId,
    summary: e.title,
    description: e.description,
    start: { dateTime: e.start.toISOString() },
    end: { dateTime: new Date(e.start.getTime() + e.minutes * 60_000).toISOString() },
    attendees: e.attendees.map((email) => ({ email })),
    reminders: { useDefault: true },
  };
  try {
    const out = await callJson<{ id: string; htmlLink: string }>(
      'https://www.googleapis.com/calendar/v3/calendars/primary/events?sendUpdates=all',
      { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) },
      'Google Calendar',
    );
    await IntegrationModel.updateOne({ userId, provider: 'google' }, { $set: { lastUsedAt: new Date() } });
    return { id: out.id, link: out.htmlLink };
  } catch (err) {
    // 409 = this event id already exists: a retry after a lost response. Not a failure.
    if (err instanceof IntegrationError && /answered 409/.test(err.message)) return { id: e.eventId, link: '' };
    throw err;
  }
}
