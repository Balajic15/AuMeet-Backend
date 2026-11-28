import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto';
import { env } from '../config/env.js';

/*
 * Encryption at rest for integration credentials (OAuth refresh tokens, API tokens). AES-256-GCM with a key from
 * INTEGRATIONS_KEY (32+ random characters), or, if that isn't set, derived from JWT_SECRET. Set INTEGRATIONS_KEY
 * in production: then rotating JWT_SECRET (which signs everyone out) doesn't also disconnect every integration.
 * Stored format: "v1.<iv>.<tag>.<ciphertext>" (base64url).
 */

function key(): Buffer {
  const material = env.INTEGRATIONS_KEY || env.JWT_SECRET;
  return Buffer.from(hkdfSync('sha256', material, 'aumeet-integrations', 'credentials-v1', 32));
}

export function encryptSecret(value: unknown): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key(), iv);
  const data = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
  return ['v1', iv, cipher.getAuthTag(), data].map((x) => (typeof x === 'string' ? x : x.toString('base64url'))).join('.');
}

export function decryptSecret<T>(stored: string): T {
  const [v, iv, tag, data] = stored.split('.');
  if (v !== 'v1' || !iv || !tag || !data) throw new Error('Unreadable credential');
  const decipher = createDecipheriv('aes-256-gcm', key(), Buffer.from(iv, 'base64url'));
  decipher.setAuthTag(Buffer.from(tag, 'base64url'));
  const out = Buffer.concat([decipher.update(Buffer.from(data, 'base64url')), decipher.final()]);
  return JSON.parse(out.toString('utf8')) as T;
}
