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
  const host = await UserModel.findById(meeting.host).select('name');
  res.json({
    meeting: {
      ...toPublicMeeting(meeting),
      hostName: host?.name ?? 'Unknown',
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
    { $set: { 'participants.$.lastJoinedAt': now, 'participants.$.name': name } },
  );
  if (refreshed.matchedCount === 0) {
    await MeetingModel.updateOne(
      { _id: meeting._id, 'participants.identity': { $ne: identity } },
      {
        $push: {
          participants: { identity, name, user: userId ?? undefined, role, firstJoinedAt: now, lastJoinedAt: now },
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

/** Host, anyone who joined with their account, or anyone the AI heard speaking. */
async function assertCanSeeInsights(req: Request, meeting: MeetingDoc) {
  const uid = req.auth!.sub;
  if (meeting.host.toString() === uid) return;
  if (meeting.participants.some((p) => p.user?.toString() === uid)) return;
  if (await MeetingInsightModel.exists({ meetingCode: meeting.code, participantUserIds: uid })) return;
  throw forbidden('Only people who were in this meeting can see its insights');
}

// AI notes for each session of this meeting, newest first
router.get('/:code/insights', requireAuth, async (req, res) => {
  const meeting = await findByCode(req.params.code as string);
  await assertCanSeeInsights(req, meeting);

  const sessions = await MeetingInsightModel.find({ meetingCode: meeting.code })
    .sort({ startedAt: -1 })
    .limit(20)
    .lean();

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
  await assertCanSeeInsights(req, meeting);

  const lines = await TranscriptLineModel.find({ meetingCode: meeting.code, sessionId: String(req.params.sessionId) })
    .sort({ seq: 1 })
    .limit(5000)
    .select({ _id: 0, seq: 1, speakerName: 1, isAgent: 1, channel: 1, text: 1, at: 1 })
    .lean();

  if (req.query.format === 'txt') {
    const body = lines
      .map((l) => {
        const t = l.at ? new Date(l.at).toISOString().slice(11, 16) : '--:--';
        return `[${t} UTC] ${l.isAgent ? 'AuMeet AI' : l.speakerName}${l.channel === 'chat' ? ' (chat)' : ''}: ${l.text}`;
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
  await assertCanSeeInsights(req, meeting);
  const session = await MeetingInsightModel.findOne({ meetingCode: meeting.code, sessionId: String(req.params.sessionId) });
  if (!session) throw notFound('Session not found');
  if (!session.endedAt) throw conflict('Notes can be edited once the meeting has ended');
  return { meeting, session };
}

/** Mark the session for a fresh recap + memory index, and record who edited. */
const editedUpdate = (uid: string) => ({
  $set: { notesEditedAt: new Date(), notesEditedBy: uid },
  $unset: { memoryIndexedAt: 1, memoryAttempts: 1, memoryError: 1 },
});

const DecisionEdit = z
  .object({
    statement: z.string().trim().min(1).max(500).optional(),
    status: z.enum(['proposed', 'agreed', 'disputed', 'rejected']).optional(),
  })
  .refine((b) => Object.keys(b).length > 0, 'Nothing to update');

router.patch('/:code/insights/:sessionId/decisions/:itemId', requireAuth, async (req, res) => {
  const { session } = await editableSession(req);
  const body = DecisionEdit.parse(req.body);
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
  const { session } = await editableSession(req);
  const body = TaskEdit.parse(req.body);
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
  res.json({ ok: true });
});

router.delete('/:code/insights/:sessionId/:kind/:itemId', requireAuth, async (req, res) => {
  const field = { decisions: 'insights.decisions', tasks: 'insights.actionItems', questions: 'insights.openQuestions' }[
    String(req.params.kind)
  ];
  if (!field) throw notFound('Unknown item type');
  const { session } = await editableSession(req);
  const r = await MeetingInsightModel.updateOne({ _id: session._id }, { $pull: { [field]: { id: String(req.params.itemId) } } });
  if (r.modifiedCount === 0) throw notFound('Item not found');
  await MeetingInsightModel.updateOne({ _id: session._id }, editedUpdate(req.auth!.sub));
  res.json({ ok: true });
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

router.get('/:code/recordings', requireAuth, async (req, res) => {
  const meeting = await findByCode(req.params.code as string);
  await assertCanSeeInsights(req, meeting);
  const list = await RecordingModel.find({ meetingCode: meeting.code }).sort({ startedAt: -1 }).limit(50);
  await Promise.all(list.filter((r) => r.status === 'active').map((r) => refreshRecording(r)));
  const fresh = await RecordingModel.find({ meetingCode: meeting.code }).sort({ startedAt: -1 }).limit(50).lean();
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
