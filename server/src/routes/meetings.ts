import { Router, type Request } from 'express';
import { nanoid } from 'nanoid';
import { z } from 'zod';
import { MeetingModel, toPublicMeeting, type MeetingDoc } from '../models/Meeting.js';
import { UserModel } from '../models/User.js';
import { MeetingInsightModel, TranscriptLineModel } from '../models/Insights.js';
import { JoinRequestModel } from '../models/JoinRequest.js';
import { RecordingModel } from '../models/Recording.js';
import { MeetingDocumentModel } from '../models/MeetingDocument.js';
import { MemoryChunkModel } from '../models/MemoryChunk.js';
import multer from 'multer';
import { aiConfigured, getAi } from '../ai/gemini.js';
import { MAX_FILE_BYTES, MAX_FILES_PER_MEETING, extractDocumentText, indexDocument } from '../services/documents.js';
import { downloadUrl, recordingConfigured, refreshRecording, startRecording, stopRecording } from '../services/recording.js';
import { createHash, randomBytes } from 'node:crypto';
import { optionalAuth, requireAuth } from '../middleware/auth.js';
import {
  closeRoom,
  createParticipantToken,
  dispatchAgent,
  ensureAgent,
  muteParticipant,
  removeAgents,
  removeParticipant,
  setRoomSettings,
  type ParticipantRole,
} from '../services/livekit.js';
import { logger } from '../logger.js';
import { emailHtml, escapeHtml, mailConfigured, sendMail } from '../services/mailer.js';
import { buildIcs } from '../utils/ics.js';
import { meetingLinkFor } from '../utils/links.js';
import { generateMeetingCode, MEETING_CODE_RE } from '../utils/meetingCode.js';
import { badRequest, conflict, forbidden, gone, notFound } from '../utils/httpError.js';
import { env } from '../config/env.js';
import { BehaviourOverride, Behaviour, defaultBehaviour, mergeLayers, resolve } from '../services/aiBehaviour.js';
import { recordCorrections, type CorrectionKind } from '../services/feedback.js';
import { canSeeSession, presentDuring } from '../memory/access.js';
import { audit, auditForMeeting } from '../services/audit.js';
import { FollowActionModel, type FollowAction } from '../models/FollowAction.js';
import { executeAction, planFollowThrough, publicAction, reportTaskProgress, retryAction } from '../services/followThrough.js';

const router = Router();

const CreateBody = z.object({
  prep: z.lazy(() => PrepInput).optional(),
  title: z.string().trim().min(1).max(120).default('Untitled meeting'),
  scheduledFor: z.coerce.date().optional(),
  settings: z.lazy(() => SettingsInput).optional(),
});

const AgendaInput = z
  .array(
    z.object({
      id: z.string().max(40).optional(),
      title: z.string().trim().min(1).max(200),
      minutes: z.number().int().min(1).max(600).nullable().optional(),
    }),
  )
  .max(30);

const PrepInput = z.object({
  goal: z.string().trim().max(1000).optional(),
  agenda: AgendaInput.optional(),
  /** Earlier meeting (same host) this one follows up on; null clears it. */
  followUpOf: z.string().trim().regex(MEETING_CODE_RE, 'Invalid meeting code').nullable().optional(),
});

const SettingsInput = z.object({
  allowGuests: z.boolean().optional(),
  aiEnabled: z.boolean().optional(),
  aiProactive: z.boolean().optional(),
  aiReplyMode: z.enum(['named', 'any']).optional(),
  aiFacilitator: z.boolean().optional(),
  followUpEmail: z.boolean().optional(),
  locked: z.boolean().optional(),
  waitingRoom: z.boolean().optional(),
});

/** "Follow-up to": only one of the host's own other meetings (its notes then reach this meeting's AI). */
async function checkFollowUpOf(hostId: string, code: string | null | undefined, ownCode?: string): Promise<string | undefined> {
  if (!code) return undefined;
  if (code === ownCode) throw badRequest('A meeting cannot follow up on itself');
  const exists = await MeetingModel.exists({ code, host: hostId });
  if (!exists) throw badRequest('You can only follow up on a meeting you host');
  return code;
}

/** Stable ids so the AI's progress tracking survives edits. */
function normaliseAgenda(items: z.infer<typeof AgendaInput>) {
  return items.map((a, i) => ({
    id: a.id && /^[\w-]{1,40}$/.test(a.id) ? a.id : `a${Date.now().toString(36)}${i}`,
    title: a.title,
    ...(a.minutes ? { minutes: a.minutes } : {}),
  }));
}

const UpdateBody = z
  .object({
    prep: PrepInput.optional(),
    title: z.string().trim().min(1).max(120).optional(),
    scheduledFor: z.coerce.date().nullable().optional(),
    settings: z.lazy(() => SettingsInput).optional(),
    /** Merged into this meeting's AI behaviour; null resets it to the host's default. */
    aiBehaviour: BehaviourOverride.nullable().optional(),
    /** "merge" (default) adds to the current overrides, e.g. a live slider; "replace" sets them exactly. */
    aiBehaviourMode: z.enum(['merge', 'replace']).optional(),
  })
  .refine((b) => Object.keys(b).length > 0, 'Nothing to update');

const JoinBody = z.object({
  // Required for guests, ignored for signed-in users (their account name is used).
  name: z.string().trim().min(1).max(80).optional(),
  /** Privacy: false = the AI must not transcribe or analyse this participant. */
  transcribe: z.boolean().optional(),
});

async function findByCode(code: string): Promise<MeetingDoc> {
  if (!MEETING_CODE_RE.test(code)) throw notFound('Meeting not found');
  const meeting = await MeetingModel.findOne({ code });
  if (!meeting) throw notFound('Meeting not found');
  return meeting;
}

/** A recording that is running and hasn't been asked to stop (the file may take a while to finish). */
const RECORDING_NOW = { status: 'active', stopRequestedAt: { $exists: false } } as const;

/** Room metadata = what the agent and the browsers need to know live. */
async function pushRoomState(meeting: MeetingDoc): Promise<void> {
  const recording = !!(await RecordingModel.exists({ meetingCode: meeting.code, ...RECORDING_NOW }));
  await setRoomSettings(meeting.code, {
    aiProactive: meeting.settings?.aiProactive ?? true,
    aiReplyMode: (meeting.settings?.aiReplyMode ?? 'named') as 'named' | 'any',
    aiFacilitator: meeting.settings?.aiFacilitator ?? false,
    recording,
    prepVersion: (meeting.updatedAt ?? new Date()).getTime(),
  });
}

/** With REQUIRE_EMAIL_VERIFICATION, unverified accounts can join meetings but not create or invite. */
async function assertVerified(req: Request) {
  if (!env.REQUIRE_EMAIL_VERIFICATION) return;
  const user = await UserModel.findById(req.auth!.sub).select({ emailVerified: 1 }).lean();
  if (!user?.emailVerified) throw forbidden('Please verify your email address first (check your inbox, or resend the link from your dashboard).');
}

function assertHost(req: Request, meeting: MeetingDoc) {
  if (meeting.host.toString() !== req.auth?.sub) throw forbidden('Only the host can do this');
}

// Create a meeting
router.post('/', requireAuth, async (req, res) => {
  await assertVerified(req);
  const body = CreateBody.parse(req.body ?? {});
  const followUpOf = await checkFollowUpOf(req.auth!.sub, body.prep?.followUpOf);

  // Codes have ~47 bits of entropy; retry only guards against the astronomically rare collision.
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      const meeting = await MeetingModel.create({
        code: generateMeetingCode(),
        title: body.title,
        host: req.auth!.sub,
        scheduledFor: body.scheduledFor,
        settings: body.settings,
        prep: body.prep
          ? { goal: body.prep.goal ?? '', agenda: normaliseAgenda(body.prep.agenda ?? []), ...(followUpOf ? { followUpOf } : {}) }
          : undefined,
      });
      res.locals['auditMeeting'] = meeting.code;
      res.status(201).json({ meeting: toPublicMeeting(meeting) });
      return;
    } catch (err) {
      if ((err as { code?: number }).code !== 11000) throw err;
    }
  }
  throw new Error('Could not allocate a unique meeting code');
});

// Meetings I host or have joined, newest first
router.get('/', requireAuth, async (req, res) => {
  const uid = req.auth!.sub;
  const meetings = await MeetingModel.find({ $or: [{ host: uid }, { 'participants.user': uid }] })
    .sort({ createdAt: -1 })
    .limit(100);
  res.json({ meetings: meetings.map(toPublicMeeting) });
});

// Public lobby info – what the invite link page shows before joining
router.get('/:code', optionalAuth, async (req, res) => {
  const meeting = await findByCode(req.params.code as string);
  const host = await UserModel.findById(meeting.host).select({ name: 1, aiBehaviour: 1 });
  const ai = resolve(await defaultBehaviour(), (host as { aiBehaviour?: unknown } | null)?.aiBehaviour, meeting.get('aiBehaviour'));
  res.json({
    meeting: {
      ...toPublicMeeting(meeting),
      hostName: host?.name ?? 'Unknown',
      /** What the AI is called in this meeting (settings), e.g. "Maaya". */
      aiName: ai.name,
      isHost: meeting.host.toString() === req.auth?.sub,
      recordingAvailable: recordingConfigured(),
      documents: await MeetingDocumentModel.countDocuments({ meetingCode: meeting.code }),
    },
  });
});

// Update title / settings (host only)
router.patch('/:code', requireAuth, async (req, res) => {
  const meeting = await findByCode(req.params.code as string);
  assertHost(req, meeting);
  const body = UpdateBody.parse(req.body);

  if (body.title !== undefined) meeting.title = body.title;
  if (body.scheduledFor !== undefined) meeting.scheduledFor = body.scheduledFor ?? undefined;
  if (body.settings?.allowGuests !== undefined) meeting.settings!.allowGuests = body.settings.allowGuests;
  if (body.settings?.aiEnabled !== undefined) meeting.settings!.aiEnabled = body.settings.aiEnabled;
  if (body.settings?.aiProactive !== undefined) meeting.settings!.aiProactive = body.settings.aiProactive;
  if (body.settings?.locked !== undefined) meeting.settings!.locked = body.settings.locked;
  if (body.settings?.waitingRoom !== undefined) meeting.settings!.waitingRoom = body.settings.waitingRoom;
  if (body.settings?.aiReplyMode !== undefined) meeting.settings!.aiReplyMode = body.settings.aiReplyMode;
  if (body.settings?.aiFacilitator !== undefined) meeting.settings!.aiFacilitator = body.settings.aiFacilitator;
  if (body.settings?.followUpEmail !== undefined) meeting.settings!.followUpEmail = body.settings.followUpEmail;
  if (body.aiBehaviour !== undefined) {
    if (body.aiBehaviour === null) {
      meeting.set('aiBehaviour', undefined);
    } else {
      const next = body.aiBehaviourMode === 'replace' ? mergeLayers(body.aiBehaviour) : mergeLayers(meeting.get('aiBehaviour') ?? {}, body.aiBehaviour);
      const host = await UserModel.findById(meeting.host).select({ aiBehaviour: 1 }).lean();
      const check = Behaviour.safeParse(mergeLayers(await defaultBehaviour(), (host as { aiBehaviour?: unknown } | null)?.aiBehaviour, next));
      if (!check.success) throw badRequest('These AI settings are not valid together');
      meeting.set('aiBehaviour', next);
      meeting.markModified('aiBehaviour');
    }
  }
  if (body.prep?.followUpOf !== undefined) {
    meeting.set('prep.followUpOf', (await checkFollowUpOf(req.auth!.sub, body.prep.followUpOf, meeting.code)) ?? undefined);
  }
  if (body.prep?.goal !== undefined) meeting.set('prep.goal', body.prep.goal);
  if (body.prep?.agenda !== undefined) meeting.set('prep.agenda', normaliseAgenda(body.prep.agenda));
  const aiChanged = body.settings?.aiEnabled !== undefined && meeting.isModified('settings.aiEnabled');
  await meeting.save();

  // Apply AI changes to a meeting that is running right now (otherwise they apply next time).
  try {
    if (aiChanged && meeting.settings!.aiEnabled) {
      await dispatchAgent(meeting.code, { meetingTitle: meeting.title, proactive: meeting.settings!.aiProactive ?? true });
    } else if (aiChanged) {
      await removeAgents(meeting.code);
    }
    if (
      body.settings?.aiProactive !== undefined ||
      body.settings?.aiReplyMode !== undefined ||
      body.settings?.aiFacilitator !== undefined ||
      body.aiBehaviour !== undefined ||
      body.prep !== undefined
    ) {
      await pushRoomState(meeting);
    }
  } catch (err) {
    logger.warn({ err, code: meeting.code }, 'could not apply live AI settings');
  }

  res.json({ meeting: toPublicMeeting(meeting) });
});

// Join – returns a LiveKit access token for the browser
router.post('/:code/join', optionalAuth, async (req, res) => {
  const meeting = await findByCode(req.params.code as string);
  if (meeting.status === 'ended') throw gone('This meeting has ended');

  const body = JoinBody.parse(req.body ?? {});
  let identity: string;
  let name: string;
  let role: ParticipantRole;
  let userId: string | null = null;

  if (req.auth) {
    const user = await UserModel.findById(req.auth.sub).select('name');
    if (!user) throw notFound('User no longer exists');
    userId = user.id as string;
    identity = `user:${userId}`;
    name = user.name;
    role = meeting.host.toString() === userId ? 'host' : 'participant';
    if (meeting.settings?.locked && role !== 'host') throw forbidden('The host has locked this meeting');
  } else {
    if (meeting.settings?.locked) throw forbidden('The host has locked this meeting');
    if (!meeting.settings?.allowGuests) throw forbidden('Sign in to join this meeting');
    if (!body.name) throw badRequest('Guests must provide a display name');
    identity = `guest:${nanoid(12)}`;
    name = body.name;
    role = 'guest';
  }

  // Waiting room: everyone except the host asks first.
  if (meeting.settings?.waitingRoom && role !== 'host') {
    const secret = randomBytes(24).toString('base64url');
    const request = await JoinRequestModel.create({
      requestId: nanoid(16),
      meetingCode: meeting.code,
      secretHash: sha256(secret),
      identity,
      name,
      userId,
      role,
      transcribe: body.transcribe,
    });
    res.status(202).json({ waiting: true, requestId: request.requestId, secret });
    return;
  }

  res.json(await issueJoin(meeting, { identity, name, role, userId, transcribe: body.transcribe }));
});

/** Record the participant and mint their LiveKit token. */
async function issueJoin(
  meeting: MeetingDoc,
  p: { identity: string; name: string; role: ParticipantRole; userId: string | null; transcribe?: boolean },
) {
  const { identity, name, role, userId } = p;
  const now = new Date();
  // Refresh an existing participant entry, or append one (the $ne guard prevents duplicates).
  const refreshed = await MeetingModel.updateOne(
    { _id: meeting._id, 'participants.identity': identity },
    { $set: { 'participants.$.lastJoinedAt': now, 'participants.$.name': name }, $push: { 'participants.$.joins': { $each: [now], $slice: -100 } } },
  );
  if (refreshed.matchedCount === 0) {
    await MeetingModel.updateOne(
      { _id: meeting._id, 'participants.identity': { $ne: identity } },
      {
        $push: {
          participants: { identity, name, user: userId ?? undefined, role, firstJoinedAt: now, lastJoinedAt: now, joins: [now] },
        },
      },
    );
  }

  const token = await createParticipantToken({
    roomName: meeting.code,
    identity,
    name,
    metadata: { role, userId },
    transcribe: p.transcribe,
    agentDispatch: meeting.settings?.aiEnabled
      ? { meetingTitle: meeting.title, proactive: meeting.settings?.aiProactive ?? true }
      : undefined,
  });

  return {
    livekit: { url: env.LIVEKIT_URL, token },
    participant: { identity, name, role },
    meeting: toPublicMeeting(meeting),
  };
}

// ---------- waiting room ----------

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

/** The waiting person polls this with their secret until admitted (gets a token once) or denied. */
router.get('/:code/join-requests/:requestId', async (req, res) => {
  const meeting = await findByCode(req.params.code as string);
  const secret = String(req.query.secret ?? '');
  const r = await JoinRequestModel.findOne({ meetingCode: meeting.code, requestId: String(req.params.requestId) });
  if (!r || !secret || r.secretHash !== sha256(secret)) throw notFound('Request not found or expired');
  if (meeting.status === 'ended') throw gone('This meeting has ended');

  if (r.status === 'pending') return void res.json({ status: 'pending' });
  if (r.status === 'denied') return void res.json({ status: 'denied' });
  if (r.status === 'joined') throw gone('This request was already used');

  // Admitted: hand out the token exactly once.
  const claimed = await JoinRequestModel.updateOne({ _id: r._id, status: 'admitted' }, { $set: { status: 'joined' } });
  if (claimed.modifiedCount === 0) throw gone('This request was already used');
  res.json({
    status: 'admitted',
    ...(await issueJoin(meeting, {
      identity: r.identity,
      name: r.name,
      role: r.role as ParticipantRole,
      userId: r.userId ?? null,
      transcribe: r.transcribe ?? undefined,
    })),
  });
});

/** People waiting to be let in (host only). */
router.get('/:code/join-requests', requireAuth, async (req, res) => {
  const meeting = await findByCode(req.params.code as string);
  assertHost(req, meeting);
  const pending = await JoinRequestModel.find({ meetingCode: meeting.code, status: 'pending' })
    .sort({ createdAt: 1 })
    .limit(50)
    .lean();
  res.json({
    requests: pending.map((r) => ({ requestId: r.requestId, name: r.name, guest: r.role === 'guest', createdAt: r.createdAt })),
  });
});

const DecideBody = z.object({ action: z.enum(['admit', 'deny']) });

router.post('/:code/join-requests/:requestId', requireAuth, async (req, res) => {
  const meeting = await findByCode(req.params.code as string);
  assertHost(req, meeting);
  const { action } = DecideBody.parse(req.body);
  const r = await JoinRequestModel.updateOne(
    { meetingCode: meeting.code, requestId: String(req.params.requestId), status: 'pending' },
    { $set: { status: action === 'admit' ? 'admitted' : 'denied' } },
  );
  if (r.matchedCount === 0) throw notFound('Request not found or already handled');
  res.json({ ok: true });
});

/** Meeting-level content (documents prepared for the AI): host, anyone who joined with their account, or was heard. */
async function assertCanSeeInsights(req: Request, meeting: MeetingDoc) {
  const uid = req.auth!.sub;
  if (meeting.host.toString() === uid) return;
  if (meeting.participants.some((p) => p.user?.toString() === uid)) return;
  if (await MeetingInsightModel.exists({ meetingCode: meeting.code, participantUserIds: uid })) return;
  throw forbidden('Only people who were in this meeting can see its insights');
}

const forbiddenSession = () => forbidden('Only people who were in this session can see it');

/** One session's content (notes, transcript): host, or someone who was in THAT session. */
async function visibleSession(req: Request, meeting: MeetingDoc, sessionId: string) {
  const session = await MeetingInsightModel.findOne({ meetingCode: meeting.code, sessionId });
  if (!session) throw notFound('Session not found');
  if (!canSeeSession(req.auth!.sub, meeting, session)) throw forbiddenSession();
  return session;
}

// AI notes for each session of this meeting the user may see, newest first
router.get('/:code/insights', requireAuth, async (req, res) => {
  const meeting = await findByCode(req.params.code as string);
  await assertCanSeeInsights(req, meeting);

  const all = await MeetingInsightModel.find({ meetingCode: meeting.code })
    .sort({ startedAt: -1 })
    .limit(200)
    .lean();
  const sessions = all.filter((s) => canSeeSession(req.auth!.sub, meeting, s)).slice(0, 20);
  if (!sessions.length && all.length && meeting.host.toString() !== req.auth!.sub) throw forbiddenSession();
  await audit(req, 'notes.viewed', { meetingCode: meeting.code });

  res.json({
    meeting: toPublicMeeting(meeting),
    sessions: sessions.map((s) => ({
      sessionId: s.sessionId,
      startedAt: s.startedAt ?? null,
      updatedAt: s.updatedAt ?? null,
      endedAt: s.endedAt ?? null,
      participants: Array.isArray(s.participants)
        ? (s.participants as Array<{ name?: string }>).map((p) => p.name).filter(Boolean)
        : [],
      insights: s.insights ?? null,
      recap: s.recap ?? null,
    })),
  });
});

// Transcript lines of one session – used to show the evidence behind decisions and tasks
router.get('/:code/insights/:sessionId/transcript', requireAuth, async (req, res) => {
  const meeting = await findByCode(req.params.code as string);
  await visibleSession(req, meeting, String(req.params.sessionId));
  await audit(req, req.query.format === 'txt' ? 'transcript.downloaded' : 'transcript.viewed', { meetingCode: meeting.code, sessionId: String(req.params.sessionId) });

  const lines = await TranscriptLineModel.find({ meetingCode: meeting.code, sessionId: String(req.params.sessionId) })
    .sort({ seq: 1 })
    .limit(5000)
    .select({ _id: 0, seq: 1, speakerName: 1, isAgent: 1, channel: 1, text: 1, at: 1 })
    .lean();

  if (req.query.format === 'txt') {
    const body = lines
      .map((l) => {
        const t = l.at ? new Date(l.at).toISOString().slice(11, 16) : '--:--';
        return `[${t} UTC] ${l.isAgent ? `${l.speakerName || 'AI'} (AI)` : l.speakerName}${l.channel === 'chat' ? ' (chat)' : ''}: ${l.text}`;
      })
      .join('\n');
    const safeTitle = meeting.title.replace(/[^\w\- ]+/g, '').trim().replace(/\s+/g, '-').slice(0, 60) || 'meeting';
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${safeTitle}-transcript.txt"`);
    res.send(`${meeting.title}\n${'='.repeat(meeting.title.length)}\n\n${body}\n`);
    return;
  }

  res.json({ lines });
});

// ---------- correcting the AI's notes (after the session ended) ----------

async function editableSession(req: Request) {
  const meeting = await findByCode(req.params.code as string);
  const session = await visibleSession(req, meeting, String(req.params.sessionId));
  if (!session.endedAt) throw conflict('Notes can be edited once the meeting has ended');
  return { meeting, session };
}

/** Mark the session for a fresh recap + memory index, and record who edited. */
const editedUpdate = (uid: string) => ({
  $set: { notesEditedAt: new Date(), notesEditedBy: uid },
  $unset: { memoryIndexedAt: 1, memoryAttempts: 1, memoryError: 1 },
});

type Item = { id: string; evidence?: number[] } & Record<string, unknown>;
const itemsOf = (session: { insights?: unknown }, field: 'decisions' | 'actionItems' | 'openQuestions'): Item[] =>
  ((session.insights as Record<string, Item[] | undefined> | null)?.[field] ?? []) as Item[];

/** Feed the correction into the evaluation dataset (what the AI wrote → what people changed). */
function captureCorrection(
  req: Request,
  meeting: MeetingDoc,
  sessionId: string,
  kind: CorrectionKind,
  item: Item | null,
  changes: Array<{ action: 'edit' | 'delete' | 'add'; field?: string; before: unknown; after: unknown }>,
): Promise<void> {
  return recordCorrections(
    { hostId: meeting.host.toString(), meetingCode: meeting.code, sessionId, kind, by: req.auth!.sub, itemId: item?.id ?? null, evidenceSeqs: item?.evidence },
    changes,
  );
}

/** The fields that matter for learning (not ids, timestamps or evidence). */
function summariseItem(item: Item | null) {
  if (!item) return null;
  const { id: _id, evidence: _e, firstSeenAt: _f, updatedAt: _u, ownerIdentity: _oi, ownerUserId: _ou, ...rest } = item;
  return rest;
}

const nextItemId = (items: Item[], prefix: string) =>
  `${prefix}${1 + items.reduce((m, x) => Math.max(m, Number(x.id.startsWith(prefix) ? x.id.slice(prefix.length) : 0) || 0), 0)}`;

const DecisionEdit = z
  .object({
    statement: z.string().trim().min(1).max(500).optional(),
    status: z.enum(['proposed', 'agreed', 'disputed', 'rejected']).optional(),
  })
  .refine((b) => Object.keys(b).length > 0, 'Nothing to update');

router.patch('/:code/insights/:sessionId/decisions/:itemId', requireAuth, async (req, res) => {
  const { meeting, session } = await editableSession(req);
  const body = DecisionEdit.parse(req.body);
  const before = itemsOf(session, 'decisions').find((d) => d.id === String(req.params.itemId)) ?? null;
  const set: Record<string, unknown> = { 'insights.decisions.$[d].updatedAt': new Date().toISOString() };
  if (body.statement !== undefined) set['insights.decisions.$[d].statement'] = body.statement;
  if (body.status !== undefined) {
    set['insights.decisions.$[d].status'] = body.status;
    // A settled decision no longer needs the group to confirm it.
    if (body.status === 'agreed' || body.status === 'rejected') set['insights.decisions.$[d].confirmationNeeded'] = null;
  }
  const r = await MeetingInsightModel.updateOne(
    { _id: session._id, 'insights.decisions.id': String(req.params.itemId) },
    { $set: set },
    { arrayFilters: [{ 'd.id': String(req.params.itemId) }] },
  );
  if (r.matchedCount === 0) throw notFound('Decision not found');
  await MeetingInsightModel.updateOne({ _id: session._id }, editedUpdate(req.auth!.sub));
  await captureCorrection(
    req, meeting, session.sessionId, 'decision', before,
    (['statement', 'status'] as const).filter((f) => body[f] !== undefined).map((f) => ({ action: 'edit' as const, field: f, before: before?.[f], after: body[f] })),
  );
  res.json({ ok: true });
});

const TaskEdit = z
  .object({
    task: z.string().trim().min(1).max(500).optional(),
    owner: z.string().trim().max(80).nullable().optional(),
    dueDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
    status: z.enum(['open', 'done']).optional(),
  })
  .refine((b) => Object.keys(b).length > 0, 'Nothing to update');

router.patch('/:code/insights/:sessionId/tasks/:itemId', requireAuth, async (req, res) => {
  const { meeting, session } = await editableSession(req);
  const body = TaskEdit.parse(req.body);
  const before = itemsOf(session, 'actionItems').find((a) => a.id === String(req.params.itemId)) ?? null;
  const p = 'insights.actionItems.$[t].';
  const set: Record<string, unknown> = { [p + 'updatedAt']: new Date().toISOString() };
  if (body.task !== undefined) set[p + 'task'] = body.task;
  if (body.status !== undefined) set[p + 'status'] = body.status;
  if (body.dueDate !== undefined) {
    set[p + 'dueDate'] = body.dueDate;
    set[p + 'deadline'] = null;
  }
  if (body.owner !== undefined) {
    // Re-link the owner to a participant's account so it shows in their "My tasks".
    const people = (session.participants as Array<{ identity?: string; name?: string; userId?: string | null }> | undefined) ?? [];
    const match = body.owner ? people.find((x) => x.name?.toLowerCase() === body.owner!.toLowerCase()) : undefined;
    set[p + 'owner'] = body.owner || null;
    set[p + 'ownerIdentity'] = match?.identity ?? null;
    set[p + 'ownerUserId'] = match?.userId ?? null;
  }
  const r = await MeetingInsightModel.updateOne(
    { _id: session._id, 'insights.actionItems.id': String(req.params.itemId) },
    { $set: set },
    { arrayFilters: [{ 't.id': String(req.params.itemId) }] },
  );
  if (r.matchedCount === 0) throw notFound('Task not found');
  await MeetingInsightModel.updateOne({ _id: session._id }, editedUpdate(req.auth!.sub));
  // Ticking a task off is progress, not a correction of the AI.
  await captureCorrection(
    req, meeting, session.sessionId, 'task', before,
    (['task', 'owner', 'dueDate'] as const)
      .filter((f) => body[f] !== undefined)
      .map((f) => ({ action: 'edit' as const, field: f, before: before?.[f] ?? null, after: body[f] ?? null })),
  );
  if (body.status && before && body.status !== before['status']) {
    void reportTaskProgress(meeting.code, session.sessionId, {
      id: before.id, task: body.task ?? String(before['task']), owner: (before['owner'] as string | null) ?? null, dueDate: (before['dueDate'] as string | null) ?? null,
      external: (before['external'] as never) ?? null,
    }, body.status);
  }
  res.json({ ok: true });
});

router.delete('/:code/insights/:sessionId/:kind/:itemId', requireAuth, async (req, res) => {
  const field = { decisions: 'insights.decisions', tasks: 'insights.actionItems', questions: 'insights.openQuestions' }[
    String(req.params.kind)
  ];
  if (!field) throw notFound('Unknown item type');
  const { meeting, session } = await editableSession(req);
  const list = field.split('.')[1] as 'decisions' | 'actionItems' | 'openQuestions';
  const before = itemsOf(session, list).find((x) => x.id === String(req.params.itemId)) ?? null;
  const r = await MeetingInsightModel.updateOne({ _id: session._id }, { $pull: { [field]: { id: String(req.params.itemId) } } });
  if (r.modifiedCount === 0) throw notFound('Item not found');
  await MeetingInsightModel.updateOne({ _id: session._id }, editedUpdate(req.auth!.sub));
  const kind = ({ decisions: 'decision', actionItems: 'task', openQuestions: 'question' } as const)[list];
  await captureCorrection(req, meeting, session.sessionId, kind, before, [{ action: 'delete', before: summariseItem(before), after: null }]);
  res.json({ ok: true });
});

// ---------- follow-through (actions the agent proposes after the meeting; host reviews them) ----------

async function hostSession(req: Request) {
  const meeting = await findByCode(req.params.code as string);
  assertHost(req, meeting);
  const session = await MeetingInsightModel.findOne({ meetingCode: meeting.code, sessionId: String(req.params.sessionId) }).lean();
  if (!session) throw notFound('Session not found');
  return { meeting, session };
}

router.get('/:code/insights/:sessionId/actions', requireAuth, async (req, res) => {
  const { session } = await hostSession(req);
  const actions = await FollowActionModel.find({ sessionId: session.sessionId }).sort({ createdAt: 1 }).lean();
  res.json({
    actions: actions.map((a) => publicAction(a as FollowAction)),
    planned: !!(session as { followThroughPlannedAt?: Date }).followThroughPlannedAt,
    canPlan: aiConfigured() && !!session.endedAt,
    mail: mailConfigured(),
  });
});

// Plan (or re-plan) now instead of waiting for the worker.
router.post('/:code/insights/:sessionId/actions/plan', requireAuth, async (req, res) => {
  const { session } = await hostSession(req);
  if (!session.endedAt) throw conflict('Follow-ups are planned once the meeting has ended');
  const result = await planFollowThrough(session.sessionId, getAi(), new Date(), true);
  const actions = await FollowActionModel.find({ sessionId: session.sessionId }).sort({ createdAt: 1 }).lean();
  res.json({ ...result, actions: actions.map((a) => publicAction(a as FollowAction)) });
});

const ActionDecision = z.object({
  status: z.enum(['approved', 'dismissed']).optional(),
  title: z.string().trim().min(1).max(300).optional(),
  body: z.string().trim().max(5000).optional(),
  when: z.coerce.date().optional(),
});

router.patch('/:code/insights/:sessionId/actions/:actionId', requireAuth, async (req, res) => {
  const { session } = await hostSession(req);
  const body = ActionDecision.parse(req.body);
  const action = await FollowActionModel.findOne({ _id: String(req.params.actionId), sessionId: session.sessionId }).catch(() => null);
  if (!action) throw notFound('Action not found');
  if (action.status !== 'proposed' && !(action.status === 'approved' && !action.executedAt)) throw conflict('This action was already handled');
  if (body.title !== undefined) action.title = body.title;
  if (body.body !== undefined) action.body = body.body;
  if (body.when !== undefined) action.when = body.when;
  if (body.status) {
    action.status = body.status;
    action.decidedBy = req.auth!.sub;
    action.decidedAt = new Date();
  }
  await action.save();
  // Approving runs this action now – except a reminder, which waits for its day (the worker sends it).
  if (action.status === 'approved' && (action.kind !== 'reminder' || !action.when || action.when <= new Date())) {
    await executeAction(String(action._id));
  }
  const fresh = await FollowActionModel.findById(action._id).lean();
  res.json({ action: publicAction(fresh as FollowAction) });
});

// Try a failed follow-up again (already reached recipients and created issues are not repeated).
router.post('/:code/insights/:sessionId/actions/:actionId/retry', requireAuth, async (req, res) => {
  const { session } = await hostSession(req);
  if (!(await retryAction(String(req.params.actionId), session.sessionId))) throw conflict('Only a failed action can be retried');
  await executeAction(String(req.params.actionId));
  const fresh = await FollowActionModel.findById(String(req.params.actionId)).lean();
  res.json({ action: publicAction(fresh as FollowAction) });
});

const MissedTask = z.object({
  task: z.string().trim().min(1).max(500),
  owner: z.string().trim().max(80).nullable().optional(),
  dueDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
});

// Add a task the AI missed.
router.post('/:code/insights/:sessionId/tasks', requireAuth, async (req, res) => {
  const { meeting, session } = await editableSession(req);
  const body = MissedTask.parse(req.body);
  const people = (session.participants as Array<{ identity?: string; name?: string; userId?: string | null }> | undefined) ?? [];
  const match = body.owner ? people.find((x) => x.name?.toLowerCase() === body.owner!.toLowerCase()) : undefined;
  const now = new Date().toISOString();
  const item = {
    id: nextItemId(itemsOf(session, 'actionItems'), 't'),
    task: body.task,
    owner: body.owner || null,
    ownerIdentity: match?.identity ?? null,
    ownerUserId: match?.userId ?? null,
    deadline: null,
    dueDate: body.dueDate ?? null,
    status: 'open' as const,
    evidence: [],
    firstSeenAt: now,
    updatedAt: now,
    addedBy: req.auth!.sub,
  };
  await MeetingInsightModel.updateOne({ _id: session._id }, { $push: { 'insights.actionItems': item } });
  await MeetingInsightModel.updateOne({ _id: session._id }, editedUpdate(req.auth!.sub));
  await captureCorrection(req, meeting, session.sessionId, 'task', { id: item.id }, [
    { action: 'add', before: null, after: { task: item.task, owner: item.owner, dueDate: item.dueDate } },
  ]);
  res.status(201).json({ item });
});

const MissedDecision = z.object({
  statement: z.string().trim().min(1).max(500),
  status: z.enum(['proposed', 'agreed', 'disputed', 'rejected']).default('agreed'),
});

// Add a decision the AI missed.
router.post('/:code/insights/:sessionId/decisions', requireAuth, async (req, res) => {
  const { meeting, session } = await editableSession(req);
  const body = MissedDecision.parse(req.body);
  const now = new Date().toISOString();
  const item = {
    id: nextItemId(itemsOf(session, 'decisions'), 'd'),
    topic: '',
    statement: body.statement,
    status: body.status,
    options: [],
    proposedBy: [],
    supporters: [],
    objectors: [],
    confirmationNeeded: null,
    evidence: [],
    firstSeenAt: now,
    updatedAt: now,
    settledAt: body.status === 'agreed' || body.status === 'rejected' ? now : null,
    addedBy: req.auth!.sub,
  };
  await MeetingInsightModel.updateOne({ _id: session._id }, { $push: { 'insights.decisions': item } });
  await MeetingInsightModel.updateOne({ _id: session._id }, editedUpdate(req.auth!.sub));
  await captureCorrection(req, meeting, session.sessionId, 'decision', { id: item.id }, [
    { action: 'add', before: null, after: { statement: item.statement, status: item.status } },
  ]);
  res.status(201).json({ item });
});

const SpeakerFix = z.object({
  from: z.string().trim().min(1).max(80),
  to: z.string().trim().min(1).max(80),
  /** Only these lines (one misattributed line, say); every line of `from` when omitted. */
  seqs: z.array(z.number().int().positive()).max(500).optional(),
});

/** Fix a wrongly identified speaker in the transcript (and, for a full rename, in the notes). */
router.patch('/:code/insights/:sessionId/speakers', requireAuth, async (req, res) => {
  const { meeting, session } = await editableSession(req);
  const { from, to, seqs } = SpeakerFix.parse(req.body);
  if (from === to) throw badRequest('Nothing to change');
  const filter = { meetingCode: meeting.code, sessionId: session.sessionId, speakerName: from, ...(seqs ? { seq: { $in: seqs } } : {}) };
  const sample = await TranscriptLineModel.find(filter).sort({ seq: 1 }).limit(5).select({ seq: 1 }).lean();
  const r = await TranscriptLineModel.updateMany(filter, { $set: { speakerName: to, speakerCorrectedFrom: from } });
  if (r.matchedCount === 0) throw notFound(`No lines by ${from}`);

  if (!seqs) {
    const swap = (v: unknown) => (v === from ? to : v);
    const swapAll = (xs: unknown) => (Array.isArray(xs) ? xs.map(swap) : xs);
    const ins = (session.insights ?? {}) as Record<string, unknown>;
    await MeetingInsightModel.updateOne(
      { _id: session._id },
      {
        $set: {
          insights: {
            ...ins,
            decisions: itemsOf(session, 'decisions').map((d) => ({
              ...d, proposedBy: swapAll(d['proposedBy']), supporters: swapAll(d['supporters']), objectors: swapAll(d['objectors']),
            })),
            actionItems: itemsOf(session, 'actionItems').map((a) => ({ ...a, owner: swap(a['owner']) })),
            openQuestions: itemsOf(session, 'openQuestions').map((q) => ({ ...q, askedBy: swap(q['askedBy']) })),
          },
          participants: ((session.participants as Array<{ name?: string }> | undefined) ?? []).map((p) => ({ ...p, name: swap(p.name) })),
        },
      },
    );
  }
  await MeetingInsightModel.updateOne({ _id: session._id }, editedUpdate(req.auth!.sub));
  await recordCorrections(
    {
      hostId: meeting.host.toString(), meetingCode: meeting.code, sessionId: session.sessionId, kind: 'speaker', by: req.auth!.sub,
      itemId: null, evidenceSeqs: sample.map((l) => l.seq ?? 0),
    },
    [{ action: 'edit', field: 'speakerName', before: from, after: to }],
  );
  res.json({ ok: true, lines: r.modifiedCount });
});

// ---------- documents for the AI (prepared before the meeting) ----------

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_FILE_BYTES, files: 1 },
});

const publicDoc = (d: { _id: unknown; filename: string; mimeType: string; sizeBytes: number; pages?: number | null; chars: number; truncated?: boolean | null; indexed?: boolean | null; createdAt?: Date }) => ({
  id: String(d._id),
  filename: d.filename,
  mimeType: d.mimeType,
  sizeBytes: d.sizeBytes,
  pages: d.pages ?? null,
  chars: d.chars,
  truncated: !!d.truncated,
  indexed: !!d.indexed,
  createdAt: d.createdAt ?? null,
});

// What would carry over into this meeting: open items of the latest earlier session of this link and/or
// of the meeting it follows up on (?from=<code> previews a choice before it is saved). Host only.
// The AI behaviour for this meeting: the host's default, this meeting's overrides, and the result.
router.get('/:code/ai-behaviour', requireAuth, async (req, res) => {
  const meeting = await findByCode(req.params.code as string);
  assertHost(req, meeting);
  const host = await UserModel.findById(meeting.host).select({ aiBehaviour: 1 }).lean();
  const account = resolve(await defaultBehaviour(), (host as { aiBehaviour?: unknown } | null)?.aiBehaviour);
  const override = (meeting.get('aiBehaviour') ?? null) as BehaviourOverride | null;
  res.json({ account, meeting: override, effective: resolve(account, override) });
});

// Audit trail of this meeting: who joined, viewed or downloaded transcripts and recordings, edited notes,
// controlled the room, or approved follow-ups. Host only.
router.get('/:code/audit', requireAuth, async (req, res) => {
  const meeting = await findByCode(req.params.code as string);
  assertHost(req, meeting);
  const events = await auditForMeeting(meeting.code, 300);
  const ids = [...new Set(events.map((e) => e.actorId).filter((x): x is string => !!x && /^[a-f0-9]{24}$/.test(x)))];
  const names = new Map((await UserModel.find({ _id: { $in: ids } }).select({ name: 1 }).lean()).map((u) => [String(u._id), u.name]));
  res.json({ events: events.map((e) => ({ ...e, actorName: e.actorId ? names.get(e.actorId) ?? 'Former user' : 'Guest or system' })) });
});

router.get('/:code/carryover', requireAuth, async (req, res) => {
  const meeting = await findByCode(req.params.code as string);
  assertHost(req, meeting);
  const from = typeof req.query['from'] === 'string' && req.query['from'] ? req.query['from'] : meeting.prep?.followUpOf;
  const followUp = from ? await checkFollowUpOf(req.auth!.sub, from, meeting.code) : undefined;
  const codes = [meeting.code, ...(followUp ? [followUp] : [])];
  const last = await MeetingInsightModel.findOne({ meetingCode: { $in: codes } })
    .sort({ startedAt: -1 })
    .select({ meetingCode: 1, title: 1, startedAt: 1, 'insights.decisions': 1, 'insights.actionItems': 1 })
    .lean();
  const today = new Date().toISOString().slice(0, 10);
  const ins = (last?.insights ?? {}) as {
    decisions?: Array<{ statement: string; status: string; options?: string[] }>;
    actionItems?: Array<{ task: string; owner: string | null; dueDate: string | null; status: string }>;
  };
  const decisions = (ins.decisions ?? [])
    .filter((d) => d.status === 'disputed' || d.status === 'proposed')
    .map((d) => ({ statement: d.statement, options: d.options ?? [] }));
  const tasks = (ins.actionItems ?? [])
    .filter((a) => a.status === 'open')
    .map((a) => ({ task: a.task, owner: a.owner ?? null, dueDate: a.dueDate ?? null, overdue: !!a.dueDate && a.dueDate < today }));
  res.json({
    carryover:
      last && (decisions.length || tasks.length)
        ? {
            fromTitle: last.title ?? 'Previous meeting',
            fromDate: last.startedAt ? new Date(last.startedAt).toISOString().slice(0, 10) : '',
            decisions: decisions.slice(0, 8),
            tasks: tasks.slice(0, 8),
          }
        : null,
  });
});

router.get('/:code/documents', requireAuth, async (req, res) => {
  const meeting = await findByCode(req.params.code as string);
  await assertCanSeeInsights(req, meeting);
  const docs = await MeetingDocumentModel.find({ meetingCode: meeting.code }).sort({ createdAt: 1 }).select({ text: 0 }).lean();
  res.json({ documents: docs.map(publicDoc) });
});

router.post('/:code/documents', requireAuth, upload.single('file'), async (req, res) => {
  const meeting = await findByCode(req.params.code as string);
  assertHost(req, meeting);
  if (meeting.status === 'ended') throw gone('This meeting has ended');
  const file = req.file;
  if (!file) throw badRequest('Choose a file to upload');
  if ((await MeetingDocumentModel.countDocuments({ meetingCode: meeting.code })) >= MAX_FILES_PER_MEETING) {
    throw badRequest(`A meeting can have up to ${MAX_FILES_PER_MEETING} documents`);
  }
  // Browsers send the name as latin1 in multipart; restore UTF-8 names (e.g. Hindi file names).
  const filename = Buffer.from(file.originalname, 'latin1').toString('utf8').slice(0, 200);
  const { text, pages, truncated } = await extractDocumentText(file.buffer, filename);

  const doc = await MeetingDocumentModel.create({
    meetingCode: meeting.code,
    uploadedBy: req.auth!.sub,
    filename,
    mimeType: file.mimetype,
    sizeBytes: file.size,
    pages,
    text,
    chars: text.length,
    truncated,
  });

  if (aiConfigured()) {
    try {
      await indexDocument(getAi(), { id: doc.id, meetingCode: meeting.code, filename, text });
      doc.indexed = true;
      await doc.save();
    } catch (err) {
      logger.warn({ err, code: meeting.code }, 'document saved but not indexed');
    }
  }
  await pushRoomState(meeting); // a running AI reloads its material
  res.status(201).json({ document: publicDoc(doc.toObject()) });
});

router.delete('/:code/documents/:docId', requireAuth, async (req, res) => {
  const meeting = await findByCode(req.params.code as string);
  assertHost(req, meeting);
  const id = String(req.params.docId);
  if (!/^[a-f0-9]{24}$/.test(id)) throw notFound('Document not found');
  const r = await MeetingDocumentModel.deleteOne({ _id: id, meetingCode: meeting.code });
  if (r.deletedCount === 0) throw notFound('Document not found');
  await MemoryChunkModel.deleteMany({ kind: 'document', ref: id });
  await pushRoomState(meeting);
  res.json({ ok: true });
});

// ---------- make sure the AI is in the meeting ----------

/**
 * Called by the browser a few seconds after joining (and by the "Invite AI" button) when the AI
 * hasn't appeared – e.g. the room already existed, so the join token couldn't dispatch it.
 */
router.post('/:code/ai/ensure', optionalAuth, async (req, res) => {
  const meeting = await findByCode(req.params.code as string);
  if (meeting.status === 'ended') throw gone('This meeting has ended');
  if (!meeting.settings?.aiEnabled) {
    res.status(409).json({ error: 'The AI participant is turned off for this meeting.', result: 'disabled' });
    return;
  }
  let result;
  try {
    result = await ensureAgent(meeting.code, { meetingTitle: meeting.title, proactive: meeting.settings?.aiProactive ?? true });
  } catch (err) {
    logger.warn({ err, code: meeting.code }, 'could not dispatch AI');
    throw badRequest('Could not invite the AI right now. Try again in a moment.');
  }
  res.json({ ok: true, result });
});

// ---------- recording ----------

router.post('/:code/recording/start', requireAuth, async (req, res) => {
  const meeting = await findByCode(req.params.code as string);
  assertHost(req, meeting);
  if (!recordingConfigured()) {
    res.status(503).json({ error: 'Recording is not set up on this server (RECORDING_S3_* settings).' });
    return;
  }
  if (await RecordingModel.exists({ meetingCode: meeting.code, ...RECORDING_NOW })) throw conflict('Already recording');
  let rec;
  try {
    rec = await startRecording(meeting.code, req.auth!.sub);
  } catch (err) {
    logger.warn({ err, code: meeting.code }, 'could not start recording');
    throw badRequest('Could not start recording. Is the meeting running?');
  }
  await pushRoomState(meeting);
  res.status(201).json({ recording: { id: rec.id, startedAt: rec.startedAt } });
});

router.post('/:code/recording/stop', requireAuth, async (req, res) => {
  const meeting = await findByCode(req.params.code as string);
  assertHost(req, meeting);
  const rec = await RecordingModel.findOne({ meetingCode: meeting.code, ...RECORDING_NOW });
  if (!rec) throw notFound('Not recording');
  await stopRecording(rec);
  // If LiveKit hasn't finalised the file yet, it's "processing"; the list refreshes it later.
  await RecordingModel.updateOne({ _id: rec._id, status: 'active' }, { $set: { stopRequestedAt: new Date() } });
  await pushRoomState(meeting);
  res.json({ ok: true });
});

/** A recording is visible to the host and to people who were in the meeting while it was recorded. */
async function recordingVisible(req: Request, meeting: MeetingDoc, rec: { startedAt: Date; endedAt?: Date | null }) {
  const sessions = await MeetingInsightModel.find({ meetingCode: meeting.code })
    .select({ sessionId: 1, meetingCode: 1, startedAt: 1, endedAt: 1, updatedAt: 1, participantUserIds: 1 })
    .lean();
  const from = new Date(rec.startedAt).getTime();
  const to = rec.endedAt ? new Date(rec.endedAt).getTime() : Date.now();
  return presentDuring(req.auth!.sub, meeting, sessions, from, to);
}

router.get('/:code/recordings', requireAuth, async (req, res) => {
  const meeting = await findByCode(req.params.code as string);
  await assertCanSeeInsights(req, meeting);
  const list = await RecordingModel.find({ meetingCode: meeting.code }).sort({ startedAt: -1 }).limit(50);
  await Promise.all(list.filter((r) => r.status === 'active').map((r) => refreshRecording(r)));
  const all = await RecordingModel.find({ meetingCode: meeting.code }).sort({ startedAt: -1 }).limit(50).lean();
  const fresh = [];
  for (const r of all) if (await recordingVisible(req, meeting, r)) fresh.push(r);
  res.json({
    recordings: fresh.map((r) => ({
      id: String(r._id),
      status: r.status,
      startedAt: r.startedAt,
      endedAt: r.endedAt ?? null,
      durationSec: r.durationSec ?? null,
      sizeBytes: r.sizeBytes ?? null,
    })),
  });
});

router.get('/:code/recordings/:id/download', requireAuth, async (req, res) => {
  const meeting = await findByCode(req.params.code as string);
  await assertCanSeeInsights(req, meeting);
  if (!recordingConfigured()) throw notFound('Recording is not set up');
  const id = String(req.params.id);
  const rec = /^[a-f0-9]{24}$/.test(id) ? await RecordingModel.findOne({ _id: id, meetingCode: meeting.code }) : null;
  if (!rec || rec.status !== 'complete') throw notFound('Recording not available');
  if (!(await recordingVisible(req, meeting, rec))) throw forbidden('Only people who were in the meeting while it was recorded can download it');
  await audit(req, 'recording.downloaded', { meetingCode: meeting.code, target: id });
  const day = rec.startedAt.toISOString().slice(0, 10);
  const safeTitle = meeting.title.replace(/[^\w\- ]+/g, '').trim().replace(/\s+/g, '-').slice(0, 60) || 'meeting';
  res.redirect(await downloadUrl(rec, `${safeTitle}-${day}.mp4`));
});

// ---------- email invitations ----------

const InviteBody = z.object({
  emails: z.array(z.email()).min(1).max(20),
  message: z.string().trim().max(500).optional(),
});

router.post('/:code/invite', requireAuth, async (req, res) => {
  const meeting = await findByCode(req.params.code as string);
  assertHost(req, meeting);
  await assertVerified(req);
  if (meeting.status === 'ended') throw gone('This meeting has ended');
  const { emails, message } = InviteBody.parse(req.body);
  if (!mailConfigured()) {
    res.status(503).json({ error: "Email isn't set up on this server yet (SMTP_URL). Copy the link instead." });
    return;
  }

  const host = await UserModel.findById(req.auth!.sub).select('name');
  const hostName = host?.name ?? 'Someone';
  const url = meetingLinkFor(meeting.code);
  const when = meeting.scheduledFor
    ? meeting.scheduledFor.toUTCString().replace(' GMT', ' UTC')
    : null;
  const ics = meeting.scheduledFor
    ? buildIcs({ uid: `${meeting.code}@aumeet`, title: meeting.title, start: meeting.scheduledFor, url, organizerName: hostName, description: message })
    : null;

  let sent = 0;
  for (const to of [...new Set(emails.map((e) => e.toLowerCase()))]) {
    try {
      await sendMail({
        to,
        subject: `${hostName} invited you to "${meeting.title}"`,
        text: [`${hostName} invited you to "${meeting.title}" on AuMeet.`, when ? `When: ${when}` : '', message ?? '', `Join: ${url}`]
          .filter(Boolean)
          .join('\n\n'),
        html: emailHtml(
          meeting.title,
          `<p>${escapeHtml(hostName)} invited you to a meeting on AuMeet.</p>` +
            (when ? `<p><strong>When:</strong> ${escapeHtml(when)}</p>` : '') +
            (message ? `<p style="white-space:pre-line">${escapeHtml(message)}</p>` : '') +
            `<p style="color:#8a8a8a">Meeting code: ${meeting.code}</p>`,
          { label: 'Join meeting', url },
        ),
        attachments: ics ? [{ filename: 'invite.ics', content: ics, contentType: 'text/calendar; charset=utf-8; method=PUBLISH' }] : undefined,
      });
      sent++;
    } catch (err) {
      logger.warn({ err, code: meeting.code }, 'invite email failed');
    }
  }
  res.json({ ok: true, sent });
});

// ---------- host controls during a meeting ----------

const IDENTITY_RE = /^(user:[a-f0-9]{24}|guest:[\w-]{6,32}|agent-[\w-]{1,64})$/i;
const MuteBody = z.object({ source: z.enum(['microphone', 'camera', 'screen']).default('microphone') });

router.post('/:code/participants/:identity/mute', requireAuth, async (req, res) => {
  const meeting = await findByCode(req.params.code as string);
  assertHost(req, meeting);
  const identity = String(req.params.identity);
  if (!IDENTITY_RE.test(identity)) throw notFound('Participant not found');
  const { source } = MuteBody.parse(req.body ?? {});
  let muted: number;
  try {
    muted = await muteParticipant(meeting.code, identity, source);
  } catch {
    throw notFound('Participant is not in the meeting');
  }
  res.json({ ok: true, muted });
});

router.post('/:code/participants/:identity/remove', requireAuth, async (req, res) => {
  const meeting = await findByCode(req.params.code as string);
  assertHost(req, meeting);
  const identity = String(req.params.identity);
  if (!IDENTITY_RE.test(identity)) throw notFound('Participant not found');
  if (identity === `user:${req.auth!.sub}`) throw badRequest('Use Leave to leave the meeting');
  try {
    await removeParticipant(meeting.code, identity);
  } catch {
    throw notFound('Participant is not in the meeting');
  }
  res.json({ ok: true });
});

// End meeting for everyone (host only)
router.post('/:code/end', requireAuth, async (req, res) => {
  const meeting = await findByCode(req.params.code as string);
  assertHost(req, meeting);

  if (meeting.status !== 'ended') {
    meeting.status = 'ended';
    meeting.endedAt = new Date();
    await meeting.save();
    await closeRoom(meeting.code);
  }
  res.json({ meeting: toPublicMeeting(meeting) });
});

export default router;
