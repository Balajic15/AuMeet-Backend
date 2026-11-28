import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { z } from 'zod';
import { tokenFrom } from './session.js';
import { createApp } from '../src/app.js';
import { setAiForTests, type AiClient } from '../src/ai/gemini.js';
import { captureMailForTests } from '../src/services/mailer.js';
import { hostsToLearn, learnLessons, LessonsOutput } from '../src/services/feedback.js';
import { planFollowThrough, planOverdueNudges, runDueActions, isPrivateAddress, PlanOutput, NudgeOutput } from '../src/services/followThrough.js';
import { balanceIndex } from '../src/services/analytics.js';
import { ensureDefaultProfile, defaultBehaviour } from '../src/services/aiBehaviour.js';
import { AnswerOutput } from '../src/memory/search.js';

const app = createApp();
const mail = captureMailForTests();
let mongo: MongoMemoryServer;

/** Fake model: answers per schema, and remembers the prompts. */
const prompts: Array<{ system: string; prompt: string }> = [];
let replies = new Map<z.ZodType, unknown>();
const fakeAi: AiClient = {
  async structured(schema, opts) {
    prompts.push(opts);
    if (!replies.has(schema)) throw new Error('no fake reply for this schema');
    return replies.get(schema) as never;
  },
  async embed(texts) {
    return texts.map(() => [1, 0, 0]);
  },
};

beforeAll(async () => {
  mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri());
  setAiForTests(fakeAi);
});
afterAll(async () => {
  setAiForTests(null);
  await mongoose.disconnect();
  await mongo.stop();
});
beforeEach(async () => {
  await mongoose.connection.db!.dropDatabase();
  await mongoose.connection.syncIndexes();
  mail.length = 0;
  prompts.length = 0;
  replies = new Map();
});

const db = () => mongoose.connection.db!;

async function user(email: string, name: string) {
  const res = await request(app).post('/api/auth/register').send({ email, name, password: 'password123' });
  await db().collection('users').updateOne({ email }, { $set: { emailVerified: true } });
  return { id: res.body.user.id as string, auth: { Authorization: `Bearer ${tokenFrom(res)}` } };
}

async function setup() {
  const host = await user('h@test.dev', 'Hana Host');
  const ravi = await user('r@test.dev', 'Ravi Kumar');
  const { code } = (await request(app).post('/api/meetings').set(host.auth).send({ title: 'Launch' })).body.meeting;
  await db().collection('meeting_insights').insertOne({
    sessionId: 's1', meetingCode: code, title: 'Launch',
    startedAt: new Date('2026-11-20T10:00:00Z'), endedAt: new Date('2026-11-20T10:30:00Z'), memoryIndexedAt: new Date(), memoryAttempts: 1,
    participants: [
      { identity: `user:${host.id}`, name: 'Hana Host', userId: host.id },
      { identity: `user:${ravi.id}`, name: 'Ravi Kumar', userId: ravi.id },
    ],
    participantUserIds: [host.id, ravi.id],
    recap: { headline: 'Launch plan set', overview: 'We planned the launch.', highlights: [], nextSteps: [], generatedAt: '' },
    insights: {
      summary: 'Launch planning',
      topics: [{ id: 'p1', title: 'Launch date', status: 'closed' }],
      agenda: [{ id: 'a1', title: 'Date', minutes: 10, status: 'done' }, { id: 'a2', title: 'Budget', minutes: 10, status: 'not_started' }],
      decisions: [
        { id: 'd1', statement: 'Launch on 1 December', status: 'agreed', firstSeenAt: '2026-11-20T10:05:00Z', settledAt: '2026-11-20T10:11:00Z', evidence: [1] },
        { id: 'd2', statement: 'Which pricing tier', status: 'disputed', evidence: [2] },
      ],
      actionItems: [
        { id: 't1', task: 'Write the launch post', owner: 'Ravi Kumar', ownerUserId: ravi.id, dueDate: '2026-11-25', deadline: null, status: 'open', evidence: [2] },
        { id: 't2', task: 'Book the venue', owner: 'Hana Host', ownerUserId: host.id, dueDate: '2099-01-10', deadline: null, status: 'done', evidence: [1] },
      ],
      openQuestions: [{ id: 'q1', question: 'Budget?', status: 'open' }],
      risks: [{ id: 'r1', kind: 'dependency', description: 'Post needs the final price, which is undecided', status: 'open', severity: 'high' }],
    },
  });
  await db().collection('transcripts').insertMany([
    { meetingCode: code, sessionId: 's1', seq: 1, speakerName: 'Hana Host', isAgent: false, channel: 'voice', text: 'We launch on the first', at: new Date('2026-11-20T10:02:00Z'), durationMs: 60_000 },
    { meetingCode: code, sessionId: 's1', seq: 2, speakerName: 'Ravi Kumar', isAgent: false, channel: 'voice', text: 'I will write the post by Wednesday', at: new Date('2026-11-20T10:04:00Z'), durationMs: 20_000 },
    { meetingCode: code, sessionId: 's1', seq: 3, speakerName: 'AuMeet', isAgent: true, channel: 'voice', text: 'Noted.', at: new Date('2026-11-20T10:05:00Z') },
  ]);
  mail.length = 0; // sign-up confirmation emails
  return { host, ravi, code };
}

describe('feedback engine', () => {
  it('records corrections with the evidence, finds recurring mistakes and learns lessons', async () => {
    const { host, ravi, code } = await setup();
    await request(app).patch(`/api/meetings/${code}/insights/s1/tasks/t1`).set(ravi.auth).send({ owner: 'Hana Host', dueDate: '2026-11-26' }).expect(200);
    await request(app).patch(`/api/meetings/${code}/insights/s1/tasks/t1`).set(ravi.auth).send({ status: 'done' }).expect(200);
    await request(app).delete(`/api/meetings/${code}/insights/s1/decisions/d2`).set(ravi.auth).expect(200);
    const added = await request(app).post(`/api/meetings/${code}/insights/s1/tasks`).set(ravi.auth).send({ task: 'Order swag', owner: 'Ravi Kumar' });
    expect(added.status).toBe(201);
    expect(added.body.item).toMatchObject({ id: 't3', ownerUserId: ravi.id });

    const rows = await db().collection('ai_corrections').find().sort({ _id: 1 }).toArray();
    // owner + dueDate edits, a delete, an add. Ticking done is not a correction.
    expect(rows.map((r) => `${r.kind}:${r.action}:${r.field}`)).toEqual(['task:edit:owner', 'task:edit:dueDate', 'decision:delete:null', 'task:add:null']);
    expect(rows[0]).toMatchObject({ hostId: host.id, before: 'Ravi Kumar', after: 'Hana Host', evidence: [{ seq: 2, speaker: 'Ravi Kumar' }] });
    expect(rows[2]!['before']).toMatchObject({ statement: 'Which pricing tier', status: 'disputed' });

    const fb = await request(app).get('/api/ai/feedback').set(host.auth);
    expect(fb.body.total).toBe(4);
    expect(fb.body.mistakes).toHaveLength(4);
    expect(fb.body.mistakes.every((m: { count: number }) => m.count === 1)).toBe(true);

    expect(await hostsToLearn()).toEqual([host.id]);
    const rule = 'Only record a task owner who accepted it';
    replies.set(LessonsOutput, {
      lessons: [
        { text: rule, topic: 'owner', basedOn: [1, 2, 3, 4], contradictedBy: [], confidence: 0.9 },
        { text: ' ', topic: 'x', basedOn: [1], contradictedBy: [], confidence: 1 },
        { text: 'Made up from nothing', topic: 'x', basedOn: [99], contradictedBy: [], confidence: 1 },
      ],
    });
    const doc = await learnLessons(host.id, fakeAi);
    // All four corrections come from ONE meeting: not enough to become a rule.
    expect(doc!.versions[0]!.lessons).toEqual([
      expect.objectContaining({ id: 'L1', text: rule, status: 'candidate', support: { corrections: 4, sessions: 1, people: 1 }, reason: expect.stringContaining('2 meetings') }),
    ]);
    expect(prompts.at(-1)!.prompt).toContain('task.owner: AI wrote "Ravi Kumar" → corrected to "Hana Host"');
    expect(await hostsToLearn()).toEqual([]);

    // Switching a lesson off keeps it from coming back.
    const off = await request(app).patch('/api/ai/feedback/lessons/L1').set(host.auth).send({ active: false });
    expect(off.body.disabled).toEqual([rule]);
    expect(off.body.lessons[0]).toMatchObject({ status: 'off' });
    await learnLessons(host.id, fakeAi);
    const after = (await request(app).get('/api/ai/feedback').set(host.auth)).body;
    expect(after.lessons.filter((l: { text: string; status: string }) => l.text === rule).map((l: { status: string }) => l.status)).toEqual(['off']);

    const ds = await request(app).get('/api/ai/feedback/dataset').set(host.auth);
    expect(ds.text.trim().split('\n')).toHaveLength(4);
  });

  it('fixes a misidentified speaker in the transcript and the notes', async () => {
    const { ravi, code } = await setup();
    const r = await request(app).patch(`/api/meetings/${code}/insights/s1/speakers`).set(ravi.auth).send({ from: 'Ravi Kumar', to: 'Priya Shah' });
    expect(r.body).toMatchObject({ ok: true, lines: 1 });
    const line = await db().collection('transcripts').findOne({ seq: 2 });
    expect(line).toMatchObject({ speakerName: 'Priya Shah', speakerCorrectedFrom: 'Ravi Kumar' });
    const s = await db().collection('meeting_insights').findOne({ sessionId: 's1' });
    expect(s!['insights'].actionItems[0].owner).toBe('Priya Shah');
    expect(await db().collection('ai_corrections').findOne({ kind: 'speaker' })).toMatchObject({ before: 'Ravi Kumar', after: 'Priya Shah' });
  });
});

describe('follow-through agent', () => {
  const plan: PlanOutput = {
    emails: [{ to: 'Ravi Kumar', subject: 'Your launch post', body: 'Hi Ravi, you are writing the launch post (due 25 Nov).', reason: 'Owns a task' }, { to: 'Stranger', subject: 'x', body: 'y', reason: '' }],
    reminders: [{ taskId: 't1', remindOn: '2026-11-24', message: 'The launch post is due tomorrow.' }, { taskId: 't2', remindOn: '2026-11-24', message: 'done task' }],
    events: [{ title: 'Settle pricing', date: '2026-11-23', time: '15:00', durationMinutes: 30, attendees: ['Hana Host', 'Ravi Kumar'], description: 'Decide the pricing tier.', reason: 'Unresolved' }],
  };

  it('proposes actions, auto-schedules own-task reminders, and only sends emails once approved', async () => {
    const { host, code } = await setup();
    replies.set(PlanOutput, plan);
    const r = await planFollowThrough('s1', fakeAi, new Date('2026-11-20T11:00:00Z'));
    expect(r.planned).toBe(3); // unknown recipient and the done task are dropped
    expect(await planFollowThrough('s1', fakeAi)).toMatchObject({ skipped: 'already planned' });
    expect(mail).toHaveLength(0); // the reminder waits for its day; email and invite wait for approval

    const list = await request(app).get(`/api/meetings/${code}/insights/s1/actions`).set(host.auth);
    const byKind = Object.fromEntries(list.body.actions.map((a: { kind: string }) => [a.kind, a]));
    expect(byKind.reminder).toMatchObject({ status: 'approved', needsApproval: false });
    expect(byKind.email).toMatchObject({ status: 'proposed', recipients: [{ name: 'Ravi Kumar' }] });

    // Host edits and approves the email → sent.
    const ok = await request(app).patch(`/api/meetings/${code}/insights/s1/actions/${byKind.email.id}`).set(host.auth)
      .send({ body: 'Hi Ravi – edited.', status: 'approved' });
    expect(ok.body.action).toMatchObject({ status: 'done' });
    expect(mail.map((m) => [m.to, m.text.split('\n')[0]])).toEqual([['r@test.dev', 'Hi Ravi – edited.']]);

    // Calendar invite carries an .ics and a Google Calendar link.
    await request(app).patch(`/api/meetings/${code}/insights/s1/actions/${byKind.calendar.id}`).set(host.auth).send({ status: 'approved' }).expect(200);
    expect(mail).toHaveLength(3);
    expect(mail[1]!.attachments?.[0]?.content).toContain('SUMMARY:Settle pricing');
    expect(mail[1]!.text).toContain('calendar.google.com');

    // The reminder goes out on its day; not again.
    await runDueActions(new Date('2026-11-24T09:00:00Z'));
    await runDueActions(new Date('2026-11-24T10:00:00Z'));
    expect(mail.filter((m) => m.subject.startsWith('Reminder')).map((m) => m.to)).toEqual(['r@test.dev']);

    // Only the host sees and decides.
    const other = await user('x@test.dev', 'Other');
    expect((await request(app).get(`/api/meetings/${code}/insights/s1/actions`).set(other.auth)).status).toBe(403);
  });

  it('nudges owners of overdue tasks once', async () => {
    await setup();
    replies.set(NudgeOutput, { nudges: [{ key: 'overdue:s1:t1', message: 'Hi Ravi, the launch post was due on 25 Nov – how is it going?' }] });
    expect(await planOverdueNudges(fakeAi, new Date('2026-11-28T09:00:00Z'))).toBe(1);
    expect(await planOverdueNudges(fakeAi, new Date('2026-11-29T09:00:00Z'))).toBe(0);
    expect(mail.map((m) => [m.to, m.subject])).toEqual([['r@test.dev', 'Overdue: Write the launch post']]);
  });

  it('refuses private webhook addresses', () => {
    for (const ip of ['127.0.0.1', '10.1.2.3', '192.168.0.1', '172.20.0.1', '169.254.169.254', '::1', 'fd00::1']) expect(isPrivateAddress(ip)).toBe(true);
    expect(isPrivateAddress('8.8.8.8')).toBe(false);
  });
});

describe('organisational memory', () => {
  it('lists who owns what across meetings and grounds answers in the status ledger', async () => {
    const { ravi } = await setup();
    const c = await request(app).get('/api/memory/commitments').set(ravi.auth);
    expect(c.body.totals).toMatchObject({ open: 1, overdue: 1, done: 1 });
    expect(c.body.owners[0]).toMatchObject({ owner: 'Ravi Kumar', overdue: 1 });
    expect(c.body.risks[0].description).toContain('final price');

    replies.set(AnswerOutput, { answer: 'Ravi owns it; it is overdue.', sources: [] });
    const a = await request(app).post('/api/memory/ask').set(ravi.auth).send({ question: 'Who owns the launch post?' });
    expect(a.body.answer).toBe('Ravi owns it; it is overdue.');
    expect(prompts.at(-1)!.prompt).toContain('task [open, OVERDUE] "Write the launch post" – owner Ravi Kumar, due 2026-11-25');
  });
});

describe('meeting analytics', () => {
  it('measures participation, agenda, decisions and follow-through', async () => {
    const { host } = await setup();
    const r = await request(app).get('/api/analytics?days=365').set(host.auth);
    expect(r.status).toBe(200);
    const s = r.body.sessions[0];
    expect(s.speakers.map((x: { name: string; seconds: number }) => [x.name, x.seconds])).toEqual([['Hana Host', 60], ['Ravi Kumar', 20]]);
    expect(s).toMatchObject({ durationMinutes: 30, agenda: { total: 2, done: 1, completion: 0.5 }, decisions: { agreed: 1, open: 1, avgMinutesToDecide: 6 } });
    expect(s.tasks).toMatchObject({ total: 2, done: 1, completion: 0.5 });
    expect(s.unresolved).toBe(3); // disputed decision + open question + open risk
    expect(r.body.summary).toMatchObject({ meetings: 1, taskCompletion: 0.5 });
    expect(balanceIndex([0.5, 0.5])).toBe(1);
    expect(balanceIndex([1])).toBeNull();
  });
});

describe('behaviour profile', () => {
  it('fills settings added in a newer version into a stored profile without overwriting edits', async () => {
    await ensureDefaultProfile();
    await db().collection('ai_profiles').updateOne({ _id: 'default' as never }, { $unset: { 'watchFor.risks': 1 }, $set: { talkativeness: 0.9 } });
    await ensureDefaultProfile();
    const b = await defaultBehaviour();
    expect(b.watchFor.risks).toBe(true);
    expect(b.talkativeness).toBe(0.9);
  });
});
