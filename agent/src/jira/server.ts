import { createHmac } from 'node:crypto';

/*
 * Calls the AuMeet server's internal API (server/src/routes/internal.ts). The agent never holds Jira credentials:
 * creating issues and recording screens happen on the server. Requests are signed with the LiveKit API secret both
 * sides share (t=<unix seconds>,v1=<HMAC-SHA256(secret, "<t>.<body>")>).
 */

export type InternalPost = (path: string, body: unknown) => Promise<{ status: number; body: Record<string, unknown> }>;

export function internalClient(baseUrl: string, secret: string): InternalPost {
  const base = baseUrl.replace(/\/$/, '');
  return async (path, payload) => {
    const body = JSON.stringify(payload ?? {});
    const t = Math.floor(Date.now() / 1000);
    const sig = createHmac('sha256', secret).update(`${t}.${body}`).digest('hex');
    try {
      const res = await fetch(`${base}/api/internal${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-aumeet-signature': `t=${t},v1=${sig}` },
        body,
        signal: AbortSignal.timeout(60_000),
      });
      const text = await res.text();
      let json: Record<string, unknown> = {};
      try {
        json = text ? JSON.parse(text) : {};
      } catch {
        json = { message: text.slice(0, 200) };
      }
      return { status: res.status, body: json };
    } catch (err) {
      return { status: 0, body: { message: `The AuMeet server could not be reached (${(err as Error).message})` } };
    }
  };
}
