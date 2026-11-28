import { Router, type Response } from 'express';
import jwt from 'jsonwebtoken';
import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import { env } from '../config/env.js';
import { logger } from '../logger.js';
import { requireAuth } from '../middleware/auth.js';
import { readCookie } from '../services/session.js';
import { INTEGRATION_PROVIDERS, IntegrationModel, type IntegrationProvider } from '../models/Integration.js';
import { connectGoogle, googleAuthorizeUrl, googleCallbackUrl, googleConfigured, GOOGLE_SCOPES } from '../integrations/google.js';
import { IntegrationError } from '../integrations/errors.js';
import { configureProjectTool, connectProjectTool, PROJECT_TOOLS, projectToolChoices, type ProjectTool } from '../integrations/projectTools.js';
import { decryptSecret } from '../services/secrets.js';
import { audit } from '../services/audit.js';
import { HttpError, notFound } from '../utils/httpError.js';

/** Account → Integrations: Gmail + Google Calendar, Jira, Linear, Asana. */
const router = Router();
const STATE_COOKIE = 'aumeet_int';
const STATE_TTL_S = 600;

const isTool = (p: string): p is ProjectTool => (PROJECT_TOOLS as string[]).includes(p);
function knownProvider(p: string): IntegrationProvider {
  if (!(INTEGRATION_PROVIDERS as readonly string[]).includes(p)) throw notFound('Unknown integration');
  return p as IntegrationProvider;
}

/** Provider errors become readable 400s (502 when it's the provider's outage). */
async function guard<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof IntegrationError) throw new HttpError(err.retryable ? 502 : 400, err.message);
    throw err;
  }
}

async function view(userId: string) {
  const docs = await IntegrationModel.find({ userId }).lean();
  const by = new Map(docs.map((d) => [d.provider, d]));
  return {
    google: { available: googleConfigured(), redirectUri: googleCallbackUrl(), scopes: GOOGLE_SCOPES.filter((s) => s.startsWith('https://')) },
    integrations: (['google', ...PROJECT_TOOLS] as const).map((provider) => {
      const d = by.get(provider);
      return d
        ? { provider, connected: true, status: d.status, account: d.account, enabled: d.enabled, config: d.config ?? {}, lastError: d.lastError ?? null, lastUsedAt: d.lastUsedAt ?? null }
        : { provider, connected: false };
    }),
  };
}

// ---------- Google (OAuth, browser redirects) ----------

router.get('/google/start', requireAuth, (req, res) => {
  if (!googleConfigured()) throw notFound('Google is not configured on this server');
  const nonce = randomBytes(16).toString('hex');
  const state = jwt.sign({ n: nonce, u: req.auth!.sub }, env.JWT_SECRET, { expiresIn: STATE_TTL_S });
  res.cookie(STATE_COOKIE, nonce, { httpOnly: true, sameSite: 'lax', secure: env.NODE_ENV === 'production', maxAge: STATE_TTL_S * 1000, path: '/api/integrations' });
  res.redirect(googleAuthorizeUrl(state));
});

const back = (res: Response, q: Record<string, string>) => res.redirect(`${env.WEB_URL.replace(/\/$/, '')}/account?${new URLSearchParams(q)}#integrations`);

router.get('/google/callback', requireAuth, async (req, res) => {
  res.clearCookie(STATE_COOKIE, { path: '/api/integrations' });
  if (req.query['error']) return back(res, { integration: 'google', error: 'Google access was not granted' });
  try {
    // Bound to this browser (nonce cookie) and to the signed-in user who started it.
    const st = jwt.verify(String(req.query['state'] ?? ''), env.JWT_SECRET) as { n: string; u: string };
    if (st.n !== readCookie(req, STATE_COOKIE) || st.u !== req.auth!.sub) throw new Error('state mismatch');
  } catch {
    return back(res, { integration: 'google', error: 'The connection request expired, please try again' });
  }
  try {
    const r = await connectGoogle(req.auth!.sub, String(req.query['code'] ?? ''));
    await audit(req, 'integration.connected', { meta: { provider: 'google' } });
    return back(res, { integration: 'google', connected: r.account });
  } catch (err) {
    logger.warn({ err }, 'Google integration failed');
    return back(res, { integration: 'google', error: err instanceof IntegrationError ? err.message : 'Could not connect Google' });
  }
});

// ---------- everything else (JSON) ----------

router.use(requireAuth);

router.get('/', async (req, res) => {
  res.json(await view(req.auth!.sub));
});

// Jira / Linear / Asana: check the token with a real call, then store it encrypted.
router.post('/:provider/connect', async (req, res) => {
  const provider = String(req.params.provider);
  if (!isTool(provider)) throw notFound('Unknown integration');
  await guard(() => connectProjectTool(req.auth!.sub, provider, req.body));
  res.json(await view(req.auth!.sub));
});

// Where tasks should go: projects (Jira, Asana) or teams (Linear).
router.get('/:provider/choices', async (req, res) => {
  const provider = String(req.params.provider);
  if (!isTool(provider)) throw notFound('Unknown integration');
  res.json({ choices: await guard(() => projectToolChoices(req.auth!.sub, provider)) });
});

router.put('/:provider/config', async (req, res) => {
  const provider = String(req.params.provider);
  if (!isTool(provider)) throw notFound('Unknown integration');
  await guard(() => configureProjectTool(req.auth!.sub, provider, req.body));
  res.json(await view(req.auth!.sub));
});

router.patch('/:provider', async (req, res) => {
  const { enabled } = z.object({ enabled: z.boolean() }).parse(req.body);
  const provider = knownProvider(String(req.params.provider));
  const r = await IntegrationModel.updateOne({ userId: req.auth!.sub, provider }, { $set: { enabled } });
  if (r.matchedCount === 0) throw notFound('Not connected');
  // One project tool at a time.
  if (enabled && isTool(provider)) {
    await IntegrationModel.updateMany({ userId: req.auth!.sub, provider: { $in: PROJECT_TOOLS.filter((p) => p !== provider) } }, { $set: { enabled: false } });
  }
  res.json(await view(req.auth!.sub));
});

router.delete('/:provider', async (req, res) => {
  const provider = knownProvider(String(req.params.provider));
  const doc = await IntegrationModel.findOneAndDelete({ userId: req.auth!.sub, provider }).select('+secret');
  if (!doc) throw notFound('Not connected');
  if (provider === 'google') {
    // Also revoke the grant at Google, so the token is useless even if it leaked.
    try {
      const { refreshToken } = decryptSecret<{ refreshToken: string }>(doc.secret);
      await fetch(`https://oauth2.googleapis.com/revoke?token=${encodeURIComponent(refreshToken)}`, { method: 'POST', signal: AbortSignal.timeout(10_000) });
    } catch (err) {
      logger.warn({ err }, 'could not revoke the Google grant');
    }
  }
  res.json(await view(req.auth!.sub));
});

export default router;
