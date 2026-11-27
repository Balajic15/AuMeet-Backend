import type { NextFunction, Request, Response } from 'express';
import { UserModel } from '../models/User.js';
import { CSRF_HEADER, SESSION_COOKIE, readCookie } from '../services/session.js';
import { verifyAuthToken, type AuthClaims } from '../services/tokens.js';
import { forbidden, unauthorized } from '../utils/httpError.js';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      auth?: AuthClaims & { exp: number; via: 'cookie' | 'bearer' };
    }
  }
}

function readCredentials(req: Request): { token: string; via: 'cookie' | 'bearer' } | null {
  const header = req.headers.authorization;
  if (header?.startsWith('Bearer ')) {
    const token = header.slice('Bearer '.length).trim();
    if (token) return { token, via: 'bearer' };
  }
  const cookie = readCookie(req, SESSION_COOKIE);
  return cookie ? { token: cookie, via: 'cookie' } : null;
}

/** Valid signature, not expired, and not revoked (tokenVersion still matches). */
async function authenticate(req: Request): Promise<boolean> {
  const cred = readCredentials(req);
  if (!cred) return false;
  let claims;
  try {
    claims = verifyAuthToken(cred.token);
  } catch {
    return false;
  }
  const user = await UserModel.findById(claims.sub).select({ tokenVersion: 1 }).lean();
  if (!user || (user.tokenVersion ?? 0) !== claims.v) return false;
  req.auth = { ...claims, via: cred.via };
  return true;
}

/** Rejects the request unless it carries a valid session cookie or bearer token. */
export async function requireAuth(req: Request, _res: Response, next: NextFunction) {
  if (await authenticate(req)) return next();
  next(unauthorized(readCredentials(req) ? 'Your session has expired. Please sign in again.' : 'Sign in required'));
}

/** Attaches `req.auth` when signed in; otherwise continues as a guest. */
export async function optionalAuth(req: Request, _res: Response, next: NextFunction) {
  await authenticate(req);
  next();
}

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * CSRF guard for cookie sessions: any state-changing request that would be authenticated by
 * the cookie must carry the custom header. Browsers only send custom headers cross-origin after
 * a CORS preflight, which our CORS policy refuses for foreign origins. Bearer-token clients
 * aren't affected (no ambient credentials).
 */
export function csrfGuard(req: Request, _res: Response, next: NextFunction) {
  if (SAFE_METHODS.has(req.method)) return next();
  if (req.headers.authorization?.startsWith('Bearer ')) return next();
  if (!readCookie(req, SESSION_COOKIE)) return next();
  if (req.get(CSRF_HEADER) !== '1') return next(forbidden('Missing CSRF header'));
  next();
}
