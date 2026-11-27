import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { tokenFrom } from './session.js';

vi.mock('../src/services/livekit.js', async (orig) => ({
  ...(await orig<typeof import('../src/services/livekit.js')>()),
  setRoomSettings: vi.fn(async () => {}),
}));

const { createApp } = await import('../src/app.js');
const { setRoomSettings } = await import('../src/services/livekit.js');
const { captureMailForTests } = await import('../src/services/mailer.js');
const { sendFollowUps, isOwnTask } = await import('../src/memory/followup.js');
const { MeetingInsightModel } = await import('../src/models/Insights.js');
const { MeetingModel } = await import('../src/models/Meeting.js');
const { UserModel } = await import('../src/models/User.js');

const app = createApp();
const mail = captureMailForTests();
let mongo: MongoMemoryServer;
beforeAll(async () => {
  mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri());
});
afterAll(async () => {
  await mongoose.disconnect();
  await mongo.stop();
});
beforeEach(async () => {
  await mongoose.connection.db!.dropDatabase();
  await mongoose.connection.syncIndexes();
  mail.length = 0;
  vi.mocked(setRoomSettings).mockClear();
});

async function user(email: string, name = email.split('@')[0]!) {
  const res = await request(app).post('/api/auth/register').send({ email, name, password: 'password123' });
  return { id: res.body.user.id as string, auth: { Authorization: `Bearer ${tokenFrom(res)}` } };
}
const create = async (auth: Record<string, string>, body: Record<string, unknown> = {}) =>
  (await request(app).post('/api/meetings').set(auth).send({ title: 'Billing sync', ...body })).body.meeting;

describe('facilitator + follow-up email settings', () => {
  it('defaults, updates and pushes facilitator mode to a running meeting', async () => {
    const host = await user('host@test.dev');
    const m = await create(host.auth);
    expect(m.settings).toMatchObject({ aiFacilitator: false, followUpEmail: true });
    expect(m.prep.followUpOf).toBeNull();
    const res = await request(app).patch(`/api/meetings/${m.code}`).set(host.auth).send({ settings: { aiFacilitator: true, followUpEmail: false } });
    expect(res.status).toBe(200);
    expect(res.body.meeting.settings).toMatchObject({ aiFacilitator: true, followUpEmail: false });
    expect(setRoomSettings).toHaveBeenCalledWith(m.code, expect.objectContaining({ aiFacilitator: true }));
  });
});

describe('follow-up to an earlier meeting', () => {
  it('only links the host’s own other meetings and previews what carries over', async () => {
    const host = await user('host@test.dev');
    const other = await user('other@test.dev');
    const first = await create(host.auth, { title: 'Kickoff' });
    const foreign = await create(other.auth);
    const next = await create(host.auth, { title: 'Week 2', prep: { followUpOf: first.code } });
    expect(next.prep.followUpOf).toBe(first.code);

    const patch = (followUpOf: string | null) => request(app).patch(`/api/meetings/${next.code}`).set(host.auth).send({ prep: { followUpOf } });
    expect((await patch(foreign.code)).status).toBe(400);
    expect((await patch(next.code)).status).toBe(400);
    expect((await request(app).post('/api/meetings').set(host.auth).send({ prep: { followUpOf: foreign.code } })).status).toBe(400);

    // nothing recorded yet
    expect((await request(app).get(`/api/meetings/${next.code}/carryover`).set(host.auth)).body).toEqual({ carryover: null });

    await MeetingInsightModel.create({
      meetingCode: first.code, sessionId: 's1', title: 'Kickoff', startedAt: new Date('2026-11-19T10:00:00Z'),
      insights: {
        decisions: [{ id: 'd1', statement: 'Which queue to use', status: 'disputed', options: ['SQS', 'Kafka'] }, { id: 'd2', statement: 'Use PostgreSQL', status: 'agreed' }],
        actionItems: [{ id: 't1', task: 'Migration plan', owner: 'Ravi', ownerUserId: null, deadline: null, dueDate: '2026-11-21', status: 'open' }],
      },
    });
    const prev = await request(app).get(`/api/meetings/${next.code}/carryover`).set(host.auth);
    expect(prev.body.carryover).toMatchObject({
      fromTitle: 'Kickoff', fromDate: '2026-11-19',
      decisions: [{ statement: 'Which queue to use', options: ['SQS', 'Kafka'] }],
      tasks: [{ task: 'Migration plan', owner: 'Ravi', dueDate: '2026-11-21', overdue: true }],
    });
    // other people can't look, and previewing someone else's meeting is refused
    expect((await request(app).get(`/api/meetings/${next.code}/carryover`).set(other.auth)).status).toBe(403);
    expect((await request(app).get(`/api/meetings/${next.code}/carryover?from=${foreign.code}`).set(host.auth)).status).toBe(400);

    // clearing the link
    const cleared = await patch(null);
    expect(cleared.body.meeting.prep.followUpOf).toBeNull();
  });
});

describe('recap email after the meeting', () => {
  async function finishedSession(code: string, userIds: string[]) {
    await MeetingInsightModel.create({
      meetingCode: code, sessionId: 'sess-1', title: 'Billing sync', startedAt: new Date(), endedAt: new Date(),
      participantUserIds: userIds,
      insights: {
        decisions: [{ id: 'd1', statement: 'Use PostgreSQL for billing', status: 'agreed' }, { id: 'd2', statement: 'Which queue', status: 'disputed' }],
        actionItems: [
          { id: 't1', task: 'Write the migration plan', owner: 'Ravi', ownerUserId: null, deadline: 'by Friday', dueDate: '2026-11-27', status: 'open' },
          { id: 't2', task: 'Update the docs', owner: null, ownerUserId: null, deadline: null, dueDate: null, status: 'open' },
          { id: 't3', task: 'Send invite', owner: 'Ravi', ownerUserId: null, deadline: null, dueDate: null, status: 'done' },
        ],
        openQuestions: [{ id: 'q1', question: 'What is the budget?', status: 'open' }],
      },
      recap: {
        headline: 'PostgreSQL chosen for billing', overview: 'The team picked PostgreSQL; the queue is still open.',
        highlights: [], nextSteps: [], goalOutcome: { status: 'partly_met', summary: 'Database decided, queue not.' }, generatedAt: new Date().toISOString(),
      },
    });
  }

  it('emails verified attendees once, with their own tasks first', async () => {
    const host = await user('host@test.dev', 'Asha');
    const ravi = await user('ravi@test.dev', 'Ravi Kumar');
    const unverified = await user('nobody@test.dev', 'Nobody');
    const m = await create(host.auth);
    await UserModel.updateMany({ _id: { $in: [host.id, ravi.id] } }, { $set: { emailVerified: true } });
    await finishedSession(m.code, [host.id, ravi.id, unverified.id]);
    mail.length = 0; // registration emails

    expect(await sendFollowUps('sess-1')).toEqual({ sent: 2 });
    expect(mail.map((x) => x.to).sort()).toEqual(['host@test.dev', 'ravi@test.dev']);
    const toRavi = mail.find((x) => x.to === 'ravi@test.dev')!;
    expect(toRavi.subject).toBe('Billing sync: recap and your task');
    expect(toRavi.text).toContain('Your tasks:\n- Write the migration plan – Ravi, due 2026-11-27');
    expect(toRavi.text).toContain('Goal partly met: Database decided, queue not.');
    expect(toRavi.text).toContain('Still undecided:\n- Which queue');
    expect(toRavi.text).not.toContain('Send invite'); // done tasks aren't listed
    expect(toRavi.text).toContain(`/${m.code}/insights`);
    const toHost = mail.find((x) => x.to === 'host@test.dev')!;
    expect(toHost.subject).toBe('Billing sync: recap');
    expect(toHost.text).toContain('Other tasks:\n- Write the migration plan');
    expect(toHost.html).toContain('Open the meeting notes');

    // never twice (retries, edited notes, a second worker)
    expect(await sendFollowUps('sess-1')).toEqual({ sent: 0, skipped: 'already sent' });
    expect(mail).toHaveLength(2);
  });

  it('respects the host’s setting and also reaches attendees who never spoke', async () => {
    const host = await user('host@test.dev', 'Asha');
    const listener = await user('quiet@test.dev', 'Quiet');
    const m = await create(host.auth);
    await UserModel.updateMany({}, { $set: { emailVerified: true } });
    await MeetingModel.updateOne({ code: m.code }, {
      $push: { participants: { identity: `user:${listener.id}`, name: 'Quiet', user: listener.id, role: 'participant', lastJoinedAt: new Date() } },
      $set: { 'settings.followUpEmail': false },
    });
    await finishedSession(m.code, [host.id]);
    mail.length = 0;
    expect(await sendFollowUps('sess-1')).toEqual({ sent: 0, skipped: 'turned off by host' });

    await MeetingModel.updateOne({ code: m.code }, { $set: { 'settings.followUpEmail': true } });
    expect(await sendFollowUps('sess-1')).toEqual({ sent: 2 });
    expect(mail.map((x) => x.to).sort()).toEqual(['host@test.dev', 'quiet@test.dev']);
  });

  it('matches task owners by account, full name or first name', () => {
    const t = (p: object) => ({ id: 't', task: 'x', owner: null, ownerUserId: null, deadline: null, dueDate: null, status: 'open' as const, ...p });
    const ravi = { id: 'u1', name: 'Ravi Kumar' };
    expect(isOwnTask(t({ ownerUserId: 'u1' }), ravi)).toBe(true);
    expect(isOwnTask(t({ ownerUserId: 'u2', owner: 'Ravi' }), ravi)).toBe(false);
    expect(isOwnTask(t({ owner: 'ravi kumar' }), ravi)).toBe(true);
    expect(isOwnTask(t({ owner: 'Ravi' }), ravi)).toBe(true);
    expect(isOwnTask(t({ owner: 'Ben' }), ravi)).toBe(false);
  });
});
