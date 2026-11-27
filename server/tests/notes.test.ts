import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { tokenFrom } from './session.js';
import { createApp } from '../src/app.js';
import { captureMailForTests } from '../src/services/mailer.js';
import { buildIcs, icsEscape } from '../src/utils/ics.js';

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
});

async function user(email: string, name: string) {
  const res = await request(app).post('/api/auth/register').send({ email, name, password: 'password123' });
  return { id: res.body.user.id as string, auth: { Authorization: `Bearer ${tokenFrom(res)}` } };
}

async function setup(ended = true) {
  const host = await user('h@test.dev', 'Host');
  const ravi = await user('r@test.dev', 'Ravi Kumar');
  const outsider = await user('o@test.dev', 'Outsider');
  const { code } = (await request(app).post('/api/meetings').set(host.auth).send({ title: 'Planning' })).body.meeting;
  const db = mongoose.connection.db!;
  await db.collection('meeting_insights').insertOne({
    sessionId: 's1', meetingCode: code, title: 'Planning',
    startedAt: new Date('2026-11-20T10:00:00Z'),
    ...(ended ? { endedAt: new Date('2026-11-20T11:00:00Z'), memoryIndexedAt: new Date(), memoryAttempts: 1 } : {}),
    participants: [{ identity: `user:${ravi.id}`, name: 'Ravi Kumar', userId: ravi.id }],
    participantUserIds: [ravi.id],
    insights: {
      decisions: [{ id: 'd1', statement: 'Which database', status: 'disputed', confirmationNeeded: 'Confirm?' }],
      actionItems: [{ id: 't1', task: 'Draft schema', owner: null, ownerUserId: null, dueDate: null, deadline: 'soon', status: 'open' }],
      openQuestions: [{ id: 'q1', question: 'Budget?', status: 'open' }],
    },
  });
  await db.collection('transcripts').insertMany([
    { meetingCode: code, sessionId: 's1', seq: 1, speakerName: 'Host', isAgent: false, channel: 'voice', text: "Let's use MongoDB", at: new Date('2026-11-20T10:01:00Z') },
    { meetingCode: code, sessionId: 's1', seq: 2, speakerName: 'Ravi Kumar', isAgent: false, channel: 'chat', text: 'PostgreSQL!', at: new Date('2026-11-20T10:02:00Z') },
  ]);
  const doc = () => db.collection('meeting_insights').findOne({ sessionId: 's1' });
  return { host, ravi, outsider, code, doc };
}

describe('correcting AI notes', () => {
  it('lets participants fix a decision and a task, and queues a fresh recap', async () => {
    const { ravi, code, doc } = await setup();

    const d = await request(app).patch(`/api/meetings/${code}/insights/s1/decisions/d1`).set(ravi.auth)
      .send({ statement: 'Use PostgreSQL', status: 'agreed' });
    expect(d.status).toBe(200);

    const t = await request(app).patch(`/api/meetings/${code}/insights/s1/tasks/t1`).set(ravi.auth)
      .send({ owner: 'ravi kumar', dueDate: '2026-11-27' });
    expect(t.status).toBe(200);

    const s = (await doc())!;
    expect(s.insights.decisions[0]).toMatchObject({ statement: 'Use PostgreSQL', status: 'agreed', confirmationNeeded: null });
    expect(s.insights.actionItems[0]).toMatchObject({ owner: 'ravi kumar', ownerUserId: ravi.id, dueDate: '2026-11-27', deadline: null });
    expect(s.memoryIndexedAt).toBeUndefined(); // worker will re-run the recap
    expect(s.notesEditedBy).toBe(ravi.id);

    // The reassigned task now shows up in Ravi's "My tasks".
    const ov = await request(app).get('/api/memory/overview').set(ravi.auth);
    expect(ov.body.tasks.map((x: { id: string }) => x.id)).toEqual(['t1']);
  });

  it('deletes items, and refuses outsiders, live sessions and unknown items', async () => {
    const { host, outsider, code, doc } = await setup();
    expect((await request(app).delete(`/api/meetings/${code}/insights/s1/questions/q1`).set(host.auth)).status).toBe(200);
    expect((await doc())!.insights.openQuestions).toEqual([]);
    expect((await request(app).delete(`/api/meetings/${code}/insights/s1/decisions/nope`).set(host.auth)).status).toBe(404);
    expect((await request(app).delete(`/api/meetings/${code}/insights/s1/bogus/d1`).set(host.auth)).status).toBe(404);
    expect((await request(app).patch(`/api/meetings/${code}/insights/s1/decisions/d1`).set(outsider.auth).send({ status: 'agreed' })).status).toBe(403);
  });

  it('keeps notes read-only while the meeting is still running', async () => {
    const { host, code } = await setup(false);
    const res = await request(app).patch(`/api/meetings/${code}/insights/s1/decisions/d1`).set(host.auth).send({ status: 'agreed' });
    expect(res.status).toBe(409);
  });
});

describe('transcript download', () => {
  it('serves a plain-text transcript as an attachment', async () => {
    const { host, code } = await setup();
    const res = await request(app).get(`/api/meetings/${code}/insights/s1/transcript?format=txt`).set(host.auth);
    expect(res.headers['content-type']).toMatch(/text\/plain/);
    expect(res.headers['content-disposition']).toBe('attachment; filename="Planning-transcript.txt"');
    expect(res.text).toContain("[10:01 UTC] Host: Let's use MongoDB");
    expect(res.text).toContain('[10:02 UTC] Ravi Kumar (chat): PostgreSQL!');
  });
});

describe('email invitations', () => {
  it('lets the host invite people, with a calendar file for scheduled meetings', async () => {
    const host = await user('h@test.dev', 'Host');
    const other = await user('o@test.dev', 'Other');
    const { code } = (await request(app).post('/api/meetings').set(host.auth)
      .send({ title: 'Design review', scheduledFor: '2026-12-01T09:30:00Z' })).body.meeting;

    expect((await request(app).post(`/api/meetings/${code}/invite`).set(other.auth).send({ emails: ['x@test.dev'] })).status).toBe(403);
    expect((await request(app).post(`/api/meetings/${code}/invite`).set(host.auth).send({ emails: ['not-an-email'] })).status).toBe(400);

    const res = await request(app).post(`/api/meetings/${code}/invite`).set(host.auth)
      .send({ emails: ['a@test.dev', 'A@test.dev', 'b@test.dev'], message: 'Bring the mockups' });
    expect(res.body).toEqual({ ok: true, sent: 2 }); // de-duplicated
    expect(mail.map((m) => m.to)).toEqual(['a@test.dev', 'b@test.dev']);
    expect(mail[0]!.subject).toBe('Host invited you to "Design review"');
    expect(mail[0]!.text).toContain(`http://localhost:4200/${code}`);
    expect(mail[0]!.text).toContain('Bring the mockups');
    const ics = mail[0]!.attachments![0]!.content;
    expect(ics).toContain('DTSTART:20261201T093000Z');
    expect(ics).toContain('DTEND:20261201T103000Z');
  });
});

describe('ics', () => {
  it('escapes text and folds long lines', () => {
    expect(icsEscape('a, b; c\nd')).toBe('a\\, b\\; c\\nd');
    const ics = buildIcs({ uid: 'x@aumeet', title: 'T'.repeat(200), start: new Date('2026-12-01T09:00:00Z'), url: 'https://x' });
    expect(ics.split('\r\n').every((l) => l.length <= 75)).toBe(true);
    expect(ics.startsWith('BEGIN:VCALENDAR\r\n')).toBe(true);
  });
});
