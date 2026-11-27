import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { tokenFrom } from './session.js';
import request from 'supertest';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { createApp } from '../src/app.js';

const app = createApp();
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
});

async function register(email: string, name: string) {
  const res = await request(app).post('/api/auth/register').send({ email, name, password: 'password123' });
  return { ...(res.body as { user: { id: string } }), token: tokenFrom(res) };
}
const bearer = (t: string) => ({ Authorization: `Bearer ${t}` });

describe('meeting insights', () => {
  it('returns AI notes and evidence lines to the host and to people who spoke, not to outsiders', async () => {
    const host = await register('h@test.dev', 'Host');
    const speaker = await register('s@test.dev', 'Speaker'); // never joined via the API, but the AI heard them
    const outsider = await register('o@test.dev', 'Outsider');
    const { code } = (await request(app).post('/api/meetings').set(bearer(host.token)).send({ title: 'DB choice' })).body.meeting;

    const db = mongoose.connection.db!;
    // What the agent writes (agent/src/intel/store.ts, agent/src/transcript.ts)
    await db.collection('meeting_insights').insertOne({
      sessionId: 'job-1',
      meetingCode: code,
      title: 'DB choice',
      startedAt: new Date('2026-11-26T10:00:00Z'),
      updatedAt: new Date('2026-11-26T10:20:00Z'),
      endedAt: new Date('2026-11-26T10:30:00Z'),
      participants: [{ identity: `user:${speaker.user.id}`, name: 'Speaker', userId: speaker.user.id }],
      participantUserIds: [speaker.user.id],
      insights: {
        summary: 'Database choice discussed.',
        decisions: [{ id: 'd1', statement: 'Which database to use', status: 'disputed', options: ['MongoDB', 'PostgreSQL'], evidence: [1, 2] }],
        actionItems: [],
        openQuestions: [],
        topics: [],
        analyzedThrough: 2,
      },
    });
    await db.collection('transcripts').insertMany([
      { meetingCode: code, sessionId: 'job-1', seq: 2, speakerName: 'Speaker', isAgent: false, channel: 'voice', text: 'PostgreSQL is better', at: new Date() },
      { meetingCode: code, sessionId: 'job-1', seq: 1, speakerName: 'Host', isAgent: false, channel: 'voice', text: "Let's use MongoDB", at: new Date() },
      { meetingCode: 'zzz-zzzz-zzz', sessionId: 'job-1', seq: 1, speakerName: 'X', text: 'other meeting' },
    ]);

    for (const who of [host, speaker]) {
      const res = await request(app).get(`/api/meetings/${code}/insights`).set(bearer(who.token));
      expect(res.status).toBe(200);
      expect(res.body.sessions).toHaveLength(1);
      expect(res.body.sessions[0]).toMatchObject({ sessionId: 'job-1', participants: ['Speaker'] });
      expect(res.body.sessions[0].insights.decisions[0].status).toBe('disputed');
    }

    const t = await request(app).get(`/api/meetings/${code}/insights/job-1/transcript`).set(bearer(host.token));
    expect(t.body.lines.map((l: { seq: number; text: string }) => [l.seq, l.text])).toEqual([
      [1, "Let's use MongoDB"],
      [2, 'PostgreSQL is better'],
    ]);

    expect((await request(app).get(`/api/meetings/${code}/insights`).set(bearer(outsider.token))).status).toBe(403);
    expect((await request(app).get(`/api/meetings/${code}/insights/job-1/transcript`).set(bearer(outsider.token))).status).toBe(403);
    expect((await request(app).get(`/api/meetings/${code}/insights`)).status).toBe(401);
  });

  it('lets someone who joined through the app see insights even before the AI wrote any', async () => {
    const host = await register('h@test.dev', 'Host');
    const member = await register('m@test.dev', 'Member');
    const { code } = (await request(app).post('/api/meetings').set(bearer(host.token)).send({})).body.meeting;
    await request(app).post(`/api/meetings/${code}/join`).set(bearer(member.token));

    const res = await request(app).get(`/api/meetings/${code}/insights`).set(bearer(member.token));
    expect(res.status).toBe(200);
    expect(res.body.sessions).toEqual([]);
  });
});
