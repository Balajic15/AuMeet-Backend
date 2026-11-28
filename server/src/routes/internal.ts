import express, { Router, type NextFunction, type Request, type Response } from 'express';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { env } from '../config/env.js';
import { meetingLinkFor } from '../utils/links.js';
import { IssueDraftModel } from '../models/IssueDraft.js';
import { createIssueFromDraft, IssueFlowError, startScreenRecording, stopScreenRecording } from '../services/issues.js';
import { audit } from '../services/audit.js';
import { unauthorized } from '../utils/httpError.js';

/*
 * Server-to-server API for the AI agent (it never holds Jira credentials). Every request is signed with the LiveKit
 * API secret both sides share: header `x-aumeet-signature: t=<unix seconds>,v1=<hex HMAC-SHA256(secret, "<t>.<body>")>`,
 * accepted for 5 minutes. Kept in sync with agent/src/jira/server.ts.
 */

const router = Router();
const MAX_SKEW_S = 300;

export function signInternal(body: string, t = Math.floor(Date.now() / 1000)): string {
  return `t=${t},v1=${createHmac('sha256', env.LIVEKIT_API_SECRET).update(`${t}.${body}`).digest('hex')}`;
}

function verify(req: Request, _res: Response, next: NextFunction): void {
  const raw = Buffer.isBuffer(req.body) ? req.body.toString('utf8') : '';
  const m = /^t=(\d+),v1=([0-9a-f]{64})$/.exec(req.get('x-aumeet-signature') ?? '');
  const t = m ? Number(m[1]) : 0;
  const expected = m ? createHmac('sha256', env.LIVEKIT_API_SECRET).update(`${t}.${raw}`).digest('hex') : '';
  const fresh = Math.abs(Date.now() / 1000 - t) <= MAX_SKEW_S;
  if (!m || !fresh || !timingSafeEqual(Buffer.from(m[2]!), Buffer.from(expected))) {
    void audit(req, 'internal.rejected', { actorId: null, meta: { path: req.path } });
    throw unauthorized('Bad internal signature');
  }
  try {
    req.body = raw ? JSON.parse(raw) : {};
  } catch {
    req.body = {};
  }
  next();
}

router.use(express.raw({ type: '*/*', limit: '64kb' }), verify);

const Approver = z.object({ identity: z.string().max(120).nullable().optional(), name: z.string().max(120).nullable().optional(), userId: z.string().max(40).nullable().optional() });

function sendError(res: Response, err: unknown) {
  if (err instanceof IssueFlowError) return res.status(err.status).json({ message: err.message, details: err.details ?? null });
  throw err;
}

router.post('/issues/:id/create', async (req, res) => {
  const body = z.object({ approver: Approver, allowDuplicate: z.boolean().optional() }).parse(req.body);
  const d = await IssueDraftModel.findById(String(req.params.id)).select({ meetingCode: 1 }).lean().catch(() => null);
  try {
    res.json(await createIssueFromDraft(String(req.params.id), body.approver, { allowDuplicate: body.allowDuplicate, meetingLink: d ? `${meetingLinkFor(d.meetingCode)}/insights` : undefined }));
  } catch (err) {
    sendError(res, err);
  }
});

router.post('/issues/:id/recording/start', async (req, res) => {
  const body = z.object({ trackSid: z.string().min(2).max(80), by: z.string().max(120) }).parse(req.body);
  try {
    res.json(await startScreenRecording(String(req.params.id), body.trackSid, body.by));
  } catch (err) {
    sendError(res, err);
  }
});

router.post('/issues/:id/recording/stop', async (req, res) => {
  res.json({ stopped: await stopScreenRecording(String(req.params.id)) });
});

export default router;
