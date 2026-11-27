import type { Request, Response } from 'express';
import { env } from '../config/env.js';
import type { UserDoc } from '../models/User.js';
import { signAuthToken } from './tokens.js';

/** httpOnly session cookie: page scripts can't read it, so XSS can't steal the session. */
export const SESSION_COOKIE = 'aumeet_session';
/** Custom header required on cookie-authenticated writes (cross-site pages can't set it). */
export const CSRF_HEADER = 'x-aumeet-csrf';

const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

function cookieOptions() {
  return {
    httpOnly: true,
    sameSite: 'lax' as const,
    secure: env.NODE_ENV === 'production',
    path: '/',
  };
}

export function issueSession(res: Response, user: UserDoc): string {
  const token = signAuthToken({ sub: user.id, email: user.email, name: user.name, v: user.tokenVersion ?? 0 });
  res.cookie(SESSION_COOKIE, token, { ...cookieOptions(), maxAge: MAX_AGE_MS });
  return token;
}

export function clearSession(res: Response): void {
  res.clearCookie(SESSION_COOKIE, cookieOptions());
}

export function readCookie(req: Request, name: string): string | undefined {
  for (const part of (req.headers.cookie ?? '').split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) {
      try {
        return decodeURIComponent(v.join('='));
      } catch {
        return undefined;
      }
    }
  }
  return undefined;
}

/** Sessions with less than this left are renewed on the next /me call (sliding expiry). */
export const RENEW_BELOW_MS = 2 * 24 * 60 * 60 * 1000;
