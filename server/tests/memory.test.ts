import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { tokenFrom } from './session.js';
import request from 'supertest';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import type { z } from 'zod';
import { createApp } from '../src/app.js';
import { normalizeVector, setAiForTests, type AiClient } from '../src/ai/gemini.js';
import { buildChunks } from '../src/memory/chunks.js';
import { findSessionsToProcess, processSession } from '../src/memory/process.js';
import { MemoryChunkModel } from '../src/models/MemoryChunk.js';

/** Deterministic "embedding": hashed bag of words, so texts sharing words are similar. */
function fakeEmbed(text: string): number[] {
  const v = new Array(64).fill(0);
  for (const w of text.toLowerCase().match(/[a-z]+/g) ?? []) {
    if (w.length < 4) continue;
    let h = 0;
    for (const c of w) h = (h * 31 + c.charCodeAt(0)) % 64;
    v[h] += 1;
  }
  return normalizeVector(v);
}

const calls: string[] = [];
const fakeAi: AiClient = {
  async structured<T>(schema: z.ZodType<T>, opts: { prompt: string }) {
    calls.push(opts.prompt);
    if (opts.prompt.startsWith('QUESTION:')) {
      return schema.parse({ answer: 'The team chose PostgreSQL in Sprint planning.', sources: [1, 99] });
    }
    return schema.parse({
      headline: 'Team picked PostgreSQL',
      overview: 'The team compared MongoDB and PostgreSQL and agreed on PostgreSQL.',
      highlights: ['PostgreSQL chosen for the main database'],
      nextSteps: ['Asha drafts the schema by Friday'],
    });
  },
  async embed(texts) {
    return texts.map(fakeEmbed);
  },
};

const app = createApp();
let mongo: MongoMemoryServer;

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
  calls.length = 0;
});

async function register(email: string, name: string) {
  const res = await request(app).post('/api/auth/register').send({ email, name, password: 'password123' });
  return { ...(res.body as { user: { id: string } }), token: tokenFrom(res) };
}
const bearer = (t: string) => ({ Authorization: `Bearer ${t}` });

async function seedSession(opts: { code: string; sessionId: string; ownerId: string; ended?: boolean; updatedAt?: Date; title?: string }) {
  const db = mongoose.connection.db!;
  await db.collection('meeting_insights').insertOne({
    sessionId: opts.sessionId,
    meetingCode: opts.code,
    title: opts.title ?? 'Sprint planning',
    startedAt: new Date('2026-11-20T10:00:00Z'),
    updatedAt: opts.updatedAt ?? new Date(),
    ...(opts.ended === false ? {} : { endedAt: new Date('2026-11-20T10:45:00Z') }),
    participants: [{ name: 'Asha', userId: opts.ownerId }],
    participantUserIds: [opts.ownerId],
    insights: {
      summary: 'Database discussion.',
      decisions: [
        { id: 'd1', statement: 'Use PostgreSQL for the main database', status: 'agreed', options: [], supporters: ['Asha', 'Ben'] },
        { id: 'd2', statement: 'Which cloud region to use', status: 'disputed', options: ['Mumbai', 'Singapore'], confirmationNeeded: 'Can we confirm the region?' },
      ],
      actionItems: [
        { id: 't1', task: 'Draft the database schema', owner: 'Asha', ownerUserId: opts.ownerId, deadline: 'by Friday', dueDate: '2026-11-27', status: 'open' },
        { id: 't2', task: 'Check hosting prices', owner: 'Ben', ownerUserId: null, deadline: null, dueDate: null, status: 'open' },
      ],
    },
  });
  await db.collection('transcripts').insertMany(
    Array.from({ length: 15 }, (_, i) => ({
      meetingCode: opts.code,
      sessionId: opts.sessionId,
      seq: i + 1,
      speakerName: i % 2 ? 'Ben' : 'Asha',
      isAgent: false,
      text: i === 0 ? "Let's use MongoDB" : i === 1 ? 'PostgreSQL is better for relational data' : `point number ${i + 1}`,
      at: new Date(),
    })),
  );
}

describe('buildChunks', () => {
  it('makes self-contained chunks for the recap, decisions, tasks and transcript windows', () => {
    const chunks = buildChunks(
      {
        sessionId: 's', meetingCode: 'abc-defg-hij', title: 'Kickoff', startedAt: new Date('2026-11-20T10:00:00Z'),
        insights: {
          decisions: [{ id: 'd1', statement: 'Which DB', status: 'disputed', options: ['MongoDB', 'PostgreSQL'], confirmationNeeded: 'Confirm?' }],
          actionItems: [{ id: 't1', task: 'Draft schema', owner: null, ownerUserId: null, deadline: null, dueDate: null, status: 'open' }],
        },
      },
      Array.from({ length: 25 }, (_, i) => ({ seq: i + 1, speakerName: 'A', text: `line ${i + 1}` })),
      { headline: 'H', overview: 'O', highlights: [], nextSteps: [], generatedAt: '' },
    );
    expect(chunks.map((c) => c.kind)).toEqual(['recap', 'decision', 'task', 'transcript', 'transcript', 'transcript']);
    expect(chunks[1]!.text).toBe('Decision in "Kickoff" (2026-11-20) — DISPUTED: Which DB. Options: MongoDB vs PostgreSQL. Still needs confirmation: Confirm?');
    expect(chunks[2]!.text).toContain('Owner: unassigned.');
    // 12-line windows with 2 lines of overlap: starts at 1, 11, 21
    expect(chunks.slice(3).map((c) => c.ref)).toEqual(['1', '11', '21']);
  });
});

describe('processing sessions', () => {
  it('finds ended or stale sessions, writes a recap and memory, and is idempotent', async () => {
    await seedSession({ code: 'aaa-bbbb-ccc', sessionId: 'ended', ownerId: 'u1' });
    await seedSession({ code: 'aaa-bbbb-ccc', sessionId: 'live', ownerId: 'u1', ended: false });
    await seedSession({ code: 'aaa-bbbb-ccc', sessionId: 'crashed', ownerId: 'u1', ended: false, updatedAt: new Date(Date.now() - 3 * 3600_000) });

    expect((await findSessionsToProcess()).sort()).toEqual(['crashed', 'ended']);

    const res = await processSession('ended', fakeAi);
    expect(res.recap?.headline).toBe('Team picked PostgreSQL');
    expect(res.chunks).toBe(1 + 2 + 2 + 2); // recap, 2 decisions, 2 tasks, 2 transcript windows
    expect(calls[0]).toContain('STRUCTURED NOTES');

    await processSession('ended', fakeAi);
    expect(await MemoryChunkModel.countDocuments({ sessionId: 'ended' })).toBe(7);
    expect(await findSessionsToProcess()).toEqual(['crashed']);
  });

  it('gives up after repeated failures', async () => {
    await seedSession({ code: 'aaa-bbbb-ccc', sessionId: 'bad', ownerId: 'u1' });
    const broken: AiClient = { ...fakeAi, structured: async () => { throw new Error('quota exceeded'); } };
    for (let i = 0; i < 3; i++) await expect(processSession('bad', broken)).rejects.toThrow('quota');
    expect(await findSessionsToProcess()).toEqual([]);
    const doc = await mongoose.connection.db!.collection('meeting_insights').findOne({ sessionId: 'bad' });
    expect(doc).toMatchObject({ memoryAttempts: 3, memoryError: 'quota exceeded' });
  });
});

describe('memory API', () => {
  it('lists my tasks and open decisions, lets me tick tasks off, and answers questions from my meetings only', async () => {
    const asha = await register('asha@test.dev', 'Asha');
    const outsider = await register('o@test.dev', 'Outsider');
    await seedSession({ code: 'aaa-bbbb-ccc', sessionId: 's1', ownerId: asha.user.id });
    await seedSession({ code: 'zzz-zzzz-zzz', sessionId: 's2', ownerId: outsider.user.id, title: 'Secret roadmap' });
    await processSession('s1', fakeAi);
    await processSession('s2', fakeAi);

    const ov = await request(app).get('/api/memory/overview').set(bearer(asha.token));
    expect(ov.status).toBe(200);
    expect(ov.body.askEnabled).toBe(true);
    expect(ov.body.tasks).toHaveLength(1);
    expect(ov.body.tasks[0]).toMatchObject({ id: 't1', task: 'Draft the database schema', meetingCode: 'aaa-bbbb-ccc', editable: true });
    expect(ov.body.openDecisions.map((d: { id: string; meetingCode: string }) => [d.meetingCode, d.id])).toEqual([['aaa-bbbb-ccc', 'd2']]);

    // tick off
    expect((await request(app).patch('/api/memory/tasks/s1/t1').set(bearer(outsider.token)).send({ status: 'done' })).status).toBe(403);
    const done = await request(app).patch('/api/memory/tasks/s1/t1').set(bearer(asha.token)).send({ status: 'done' });
    expect(done.status).toBe(200);
    const after = await request(app).get('/api/memory/overview').set(bearer(asha.token));
    expect(after.body.tasks[0].status).toBe('done');

    // ask
    const ask = await request(app).post('/api/memory/ask').set(bearer(asha.token)).send({ question: 'Which database did we choose, PostgreSQL or MongoDB?' });
    expect(ask.status).toBe(200);
    expect(ask.body.answer).toContain('PostgreSQL');
    expect(ask.body.sources).toHaveLength(1); // the bogus source number 99 is dropped
    expect(ask.body.sources[0].meetingCode).toBe('aaa-bbbb-ccc');
    // The prompt only contained excerpts from Asha's meetings.
    expect(calls.at(-1)).not.toContain('Secret roadmap');
  });

  it('refuses to edit tasks while the meeting is still live', async () => {
    const asha = await register('asha@test.dev', 'Asha');
    await seedSession({ code: 'aaa-bbbb-ccc', sessionId: 'live', ownerId: asha.user.id, ended: false });
    const res = await request(app).patch('/api/memory/tasks/live/t1').set(bearer(asha.token)).send({ status: 'done' });
    expect(res.status).toBe(409);
  });

  it('says so when nothing relevant is found', async () => {
    const asha = await register('asha@test.dev', 'Asha');
    const res = await request(app).post('/api/memory/ask').set(bearer(asha.token)).send({ question: 'What about the offsite?' });
    expect(res.body).toEqual({ answer: "I couldn't find anything about that in your meetings.", sources: [] });
  });
});

describe('data retention', () => {
  it('deletes transcripts, notes and memory older than the retention period only', async () => {
    const { purgeOldContent } = await import('../src/memory/retention.js');
    const db = mongoose.connection.db!;
    const old = new Date('2026-01-01T00:00:00Z');
    const recent = new Date('2026-11-20T00:00:00Z');
    await db.collection('transcripts').insertMany([{ sessionId: 'a', at: old, text: 'x' }, { sessionId: 'b', at: recent, text: 'y' }]);
    await db.collection('meeting_insights').insertMany([{ sessionId: 'a', startedAt: old }, { sessionId: 'b', startedAt: recent }]);
    await db.collection('memory_chunks').insertMany([{ sessionId: 'a', startedAt: old }, { sessionId: 'b', startedAt: recent }]);

    expect(await purgeOldContent(0, new Date('2026-11-27T00:00:00Z'))).toEqual({ transcripts: 0, sessions: 0, chunks: 0, recordings: 0 });
    const res = await purgeOldContent(90, new Date('2026-11-27T00:00:00Z'));
    expect(res).toEqual({ transcripts: 1, sessions: 1, chunks: 1, recordings: 0 });
    for (const c of ['transcripts', 'meeting_insights', 'memory_chunks']) {
      expect((await db.collection(c).find().toArray()).map((d) => d.sessionId)).toEqual(['b']);
    }
  });
});
