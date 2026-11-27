import jwt, { type SignOptions } from 'jsonwebtoken';
import { env } from '../config/env.js';

export interface AuthClaims {
  sub: string; // user id
  email: string;
  name: string;
  /** User.tokenVersion at issue time; a mismatch means the session was revoked. */
  v: number;
}

export function signAuthToken(claims: AuthClaims): string {
  return jwt.sign(claims, env.JWT_SECRET, {
    expiresIn: env.JWT_EXPIRES_IN as SignOptions['expiresIn'],
  });
}

export function verifyAuthToken(token: string): AuthClaims & { exp: number } {
  const payload = jwt.verify(token, env.JWT_SECRET);
  if (typeof payload === 'string' || typeof payload.sub !== 'string') {
    throw new Error('Malformed token');
  }
  return {
    sub: payload.sub,
    email: payload.email,
    name: payload.name,
    v: typeof payload.v === 'number' ? payload.v : 0,
    exp: payload.exp ?? 0,
  };
}
