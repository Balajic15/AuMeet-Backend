import type { Request } from 'express';
import mongoose from 'mongoose';
import { env } from '../config/env.js';
import { logger } from '../logger.js';

/*
 * Audit log (`audit_events`): who did what to which meeting, when, from where. Append-only from the app's
 * point of view (there is no update or delete endpoint); old events expire after AUDIT_RETENTION_DAYS via a
 * TTL index. Covers sign-in and account security, meeting control, every read of a transcript or recording,
 * every change to the AI's notes, follow-up actions sent on someone's behalf, and AI learning changes.
 * Writing an event never fails the request.
 */

export interface AuditEvent {
  at: Date;
  action: string;
  actorId: string | null;
  /** Client IP (honours TRUST_PROXY) and request id, for tracing. */
  ip: string | null;
  requestId: string | null;
  meetingCode?: string;
  sessionId?: string;
  /** What was acted on: a participant identity, item id, recording id … */
  target?: string;
  /** Small, non-sensitive details (never transcript text, secrets or tokens). */
  meta?: Record<string, unknown>;
}

const col = () => mongoose.connection.collection<AuditEvent>('audit_events');

let ready: Promise<unknown> | null = null;
function ensureIndexes() {
  ready ??= Promise.all([
    col().createIndex({ meetingCode: 1, at: -1 }),
    col().createIndex({ actorId: 1, at: -1 }),
    col().createIndex({ at: 1 }, { expireAfterSeconds: env.AUDIT_RETENTION_DAYS * 86_400, name: 'ttl_at' }),
  ]).catch((err) => {
    ready = null;
    logger.warn({ err }, 'audit indexes could not be created');
  });
  return ready;
}

export async function audit(
  req: Request | null,
  action: string,
  details: { meetingCode?: string; sessionId?: string; target?: string; meta?: Record<string, unknown>; actorId?: string | null } = {},
): Promise<void> {
  try {
    await ensureIndexes();
    const { actorId, ...rest } = details;
    await col().insertOne({
      at: new Date(),
      action,
      actorId: actorId !== undefined ? actorId : req?.auth?.sub ?? null,
      ip: req?.ip ?? null,
      requestId: (req?.id as string | undefined) ?? null,
      ...rest,
    });
  } catch (err) {
    logger.warn({ err, action }, 'audit event not written');
  }
}

/** Readable names for the routes that change things; anything else is logged by its route pattern. */
const ACTIONS: Record<string, string> = {
  'POST /api/auth/register': 'account.registered',
  'POST /api/auth/login': 'auth.login',
  'POST /api/auth/logout': 'auth.logout',
  'POST /api/auth/logout-all': 'auth.logout_everywhere',
  'POST /api/auth/password/change': 'auth.password_changed',
  'POST /api/auth/password/forgot': 'auth.password_reset_requested',
  'POST /api/auth/password/reset': 'auth.password_reset',
  'POST /api/auth/email/verify': 'auth.email_verified',
  'PATCH /api/auth/me': 'account.updated',
  'DELETE /api/auth/me': 'account.deleted',
  'POST /api/meetings/': 'meeting.created',
  'PATCH /api/meetings/:code': 'meeting.updated',
  'POST /api/meetings/:code/join': 'meeting.joined',
  'POST /api/meetings/:code/end': 'meeting.ended',
  'POST /api/meetings/:code/invite': 'meeting.invited',
  'POST /api/meetings/:code/join-requests/:requestId': 'meeting.join_request_decided',
  'POST /api/meetings/:code/participants/:identity/mute': 'participant.muted',
  'POST /api/meetings/:code/participants/:identity/remove': 'participant.removed',
  'POST /api/meetings/:code/recording/start': 'recording.started',
  'POST /api/meetings/:code/recording/stop': 'recording.stopped',
  'POST /api/meetings/:code/documents': 'document.uploaded',
  'DELETE /api/meetings/:code/documents/:docId': 'document.deleted',
  'PATCH /api/meetings/:code/insights/:sessionId/decisions/:itemId': 'notes.decision_edited',
  'PATCH /api/meetings/:code/insights/:sessionId/tasks/:itemId': 'notes.task_edited',
  'DELETE /api/meetings/:code/insights/:sessionId/:kind/:itemId': 'notes.item_deleted',
  'POST /api/meetings/:code/insights/:sessionId/tasks': 'notes.task_added',
  'POST /api/meetings/:code/insights/:sessionId/decisions': 'notes.decision_added',
  'PATCH /api/meetings/:code/insights/:sessionId/speakers': 'transcript.speaker_corrected',
  'POST /api/meetings/:code/insights/:sessionId/actions/plan': 'followthrough.planned',
  'PATCH /api/meetings/:code/insights/:sessionId/actions/:actionId': 'followthrough.action_decided',
  'PATCH /api/memory/tasks/:sessionId/:taskId': 'task.status_changed',
  'PUT /api/ai/behaviour': 'ai.behaviour_changed',
  'PUT /api/ai/follow-through': 'followthrough.settings_changed',
  'POST /api/ai/follow-through/webhook-secret': 'followthrough.webhook_secret_rotated',
  'POST /api/ai/feedback/learn': 'learning.relearned',
  'POST /api/ai/feedback/rollback': 'learning.rolled_back',
  'PATCH /api/ai/feedback/lessons/:id': 'learning.lesson_switched',
  'PATCH /api/ai/feedback/corrections/:id': 'learning.correction_excluded',
  'PUT /api/ai/feedback/policy': 'learning.policy_changed',
  'DELETE /api/ai/feedback': 'learning.forgotten',
  'DELETE /api/ai/learning': 'learning.reactions_forgotten',
};

/** Body keys whose VALUES are safe and useful to keep (statuses, switches); other keys are listed by name only. */
const SAFE_VALUES = new Set(['status', 'active', 'excluded', 'version', 'mode', 'aiBehaviourMode', 'admit', 'decision']);

/**
 * Records every successful state-changing request under /api, plus failed sign-ins. Mounted once in app.ts;
 * reads of sensitive content (transcripts, recordings) are audited explicitly where they happen.
 */
export function auditMutations(req: Request, res: import('express').Response, next: import('express').NextFunction): void {
  if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') return next();
  res.on('finish', () => {
    // After an error the router has been left (no route/baseUrl any more): fall back to the path.
    const pattern =
      req.route && req.baseUrl ? `${req.method} ${req.baseUrl}${req.route.path}` : `${req.method} ${req.originalUrl.split('?')[0]}`;
    const failedLogin = pattern === 'POST /api/auth/login' && res.statusCode === 401;
    if (res.statusCode >= 400 && !failedLogin) return;
    const action = failedLogin ? 'auth.login_failed' : ACTIONS[pattern] ?? pattern;
    const params = { ...(req.params as Record<string, string>) };
    const { code, sessionId, ...others } = params;
    const body = req.body && typeof req.body === 'object' && !Buffer.isBuffer(req.body) ? (req.body as Record<string, unknown>) : {};
    const fields = Object.keys(body).filter((k) => !/password|token|secret/i.test(k));
    const values = Object.fromEntries(fields.filter((k) => SAFE_VALUES.has(k) && typeof body[k] !== 'object').map((k) => [k, body[k]]));
    const meta: Record<string, unknown> = { status: res.statusCode };
    if (fields.length) meta['fields'] = fields;
    if (Object.keys(values).length) meta['values'] = values;
    if (failedLogin && typeof body['email'] === 'string') meta['email'] = String(body['email']).toLowerCase().slice(0, 200);
    void audit(req, action, {
      ...(code || res.locals['auditMeeting'] ? { meetingCode: code ?? String(res.locals['auditMeeting']) } : {}),
      ...(sessionId ? { sessionId } : {}),
      ...(Object.keys(others).length ? { target: Object.values(others).join('/') } : {}),
      meta,
      ...(res.locals['auditActor'] ? { actorId: String(res.locals['auditActor']) } : {}),
    });
  });
  next();
}

export async function auditForMeeting(meetingCode: string, limit = 200) {
  return col().find({ meetingCode }, { projection: { _id: 0 } }).sort({ at: -1 }).limit(limit).toArray();
}

export async function auditForActor(actorId: string, limit = 200) {
  return col().find({ actorId }, { projection: { _id: 0 } }).sort({ at: -1 }).limit(limit).toArray();
}
