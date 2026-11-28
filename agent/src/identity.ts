import { createHmac, timingSafeEqual } from 'node:crypto';

/*
 * Who a participant really is. LiveKit lets participants change their own name and metadata, so the AI trusts:
 *   - the identity (set in the join token, cannot be changed): `user:<accountId>` or `guest:<id>`
 *   - the name/role the SERVER signed into the metadata (server/src/services/livekit.ts, participantSignature)
 * A name changed after joining is shown as unverified and never linked to an account; account ids come only
 * from the identity, never from metadata.
 */

export interface VerifiedParticipant {
  /** Account id for signed-in users (from the identity), null for guests. */
  userId: string | null;
  /** The signed name when the signature checks out, else the current name marked as unverified. */
  name: string;
  role: 'host' | 'participant' | 'guest';
  verified: boolean;
}

export function participantSignature(secret: string, identity: string, name: string, role: string, userId: string | null): string {
  const payload = ['aumeet-participant-v1', identity, name, role, userId ?? ''].join('\u0000');
  return createHmac('sha256', secret).update(payload).digest('base64url');
}

const ACCOUNT_RE = /^user:([a-f0-9]{24})$/;

export function verifyParticipant(secret: string, p: { identity: string; name?: string; metadata?: string }): VerifiedParticipant {
  const match = ACCOUNT_RE.exec(p.identity);
  const userId = match ? match[1]! : null;
  const current = (p.name || p.identity).trim();
  let meta: { name?: unknown; role?: unknown; userId?: unknown; sig?: unknown } = {};
  try {
    meta = JSON.parse(p.metadata || '{}');
  } catch {
    /* unreadable metadata = unsigned */
  }
  const role = meta.role === 'host' || meta.role === 'guest' ? meta.role : 'participant';
  const signedName = typeof meta.name === 'string' ? meta.name : '';
  const sig = typeof meta.sig === 'string' ? meta.sig : '';
  const metaUser = typeof meta.userId === 'string' ? meta.userId : null;
  const expected = participantSignature(secret, p.identity, signedName, role, metaUser);
  const valid =
    !!sig && sig.length === expected.length && timingSafeEqual(Buffer.from(sig), Buffer.from(expected)) && metaUser === userId;
  if (valid) return { userId, name: signedName || current, role, verified: true };
  return { userId, name: `${current} (unverified)`, role: userId ? 'participant' : 'guest', verified: false };
}
