import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { tokenFrom } from './session.js';
import { createApp } from '../src/app.js';
import { setAiForTests, type AiClient } from '../src/ai/gemini.js';
import {
  appliedLessons,
  corrections,
  dropReverted,
  ensureLearningPolicy,
  learnLessons,
  lessonsCol,
  LessonsOutput,
  rollbackLessons,
  recheckLessons,
  setCorrectionExcluded,
  type CorrectionRow,
} from '../src/services/feedback.js';
import type { z } from 'zod';

const app = createApp();
let mongo: MongoMemoryServer;
const prompts: string[] = [];
let reply: z.infer<typeof LessonsOutput> = { lessons: [] };
const fakeAi: AiClient = {
  async structured(_schema, opts) {
    prompts.push(opts.prompt);
    return reply as never;
  },
  async embed(texts) {
    return texts.map(() => [1]);
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
  await ensureLearningPolicy(); // seed: 3 corrections, 2 meetings, 1 person, confidence 0.7, 90 days
  prompts.length = 0;
  reply = { lessons: [] };
});

const NOW = new Date('2026-11-28T12:00:00Z');
const HOST = 'host-1';

/** Insert corrections; returns them newest first (the order the model sees them, numbered from 1). */
async function seed(rows: Array<Partial<CorrectionRow>>): Promise<CorrectionRow[]> {
  const base = (i: number): CorrectionRow => ({
    hostId: HOST, meetingCode: 'abc-defg-hij', sessionId: 's1', kind: 'task', action: 'edit', field: 'owner', itemId: `t${i}`,
    before: 'Ravi', after: null, evidence: [], by: 'u1', at: new Date(NOW.getTime() - (i + 1) * 3_600_000),
  });
  await corrections().insertMany(rows.map((r, i) => ({ ...base(i), ...r })));
  return corrections().find({ hostId: HOST }).sort({ at: -1 }).toArray();
}

const lesson = (text: string, basedOn: number[], o: Partial<z.infer<typeof LessonsOutput>['lessons'][number]> = {}) => ({
  text, topic: 'owner', basedOn, contradictedBy: [], confidence: 0.9, ...o,
});
const doc = () => lessonsCol().findOne({ _id: HOST });

describe('confidence thresholds', () => {
  it('one wrong correction never becomes a rule; a pattern across meetings does', async () => {
    await seed([{ sessionId: 's1' }]);
    reply = { lessons: [lesson('Never assign owners', [1], { confidence: 1 })] };
    let d = await learnLessons(HOST, fakeAi, NOW);
    expect(d!.versions[0]!.lessons[0]).toMatchObject({ status: 'candidate', support: { corrections: 1, sessions: 1 } });
    expect(appliedLessons(d)).toEqual([]);

    await seed([{ sessionId: 's2', by: 'u2' }, { sessionId: 's3' }]);
    reply = { lessons: [lesson('Never assign owners', [1, 2, 3])] };
    d = await learnLessons(HOST, fakeAi, NOW);
    expect(d!.versions.at(-1)!.lessons[0]).toMatchObject({ status: 'active', support: { corrections: 3, sessions: 3, people: 2 } });
    expect(appliedLessons(d)).toEqual(['Never assign owners']);
  });

  it('keeps low-confidence and contradicted lessons as candidates', async () => {
    await seed([{ sessionId: 's1' }, { sessionId: 's2' }, { sessionId: 's3' }, { sessionId: 's4', before: null, after: 'Ravi' }]);
    reply = {
      lessons: [
        lesson('Unsure pattern', [1, 2, 3], { confidence: 0.4 }),
        lesson('Disputed pattern', [1, 2, 3], { contradictedBy: [4] }),
      ],
    };
    const d = await learnLessons(HOST, fakeAi, NOW);
    const [a, b] = d!.versions[0]!.lessons;
    expect(a).toMatchObject({ status: 'candidate', reason: expect.stringContaining('confidence 0.7') });
    expect(b).toMatchObject({ status: 'candidate', reason: '1 correction goes against it' });
    expect(appliedLessons(d)).toEqual([]);
  });

  it('host can tighten the policy', async () => {
    const res = await request(app).post('/api/auth/register').send({ email: 'p@test.dev', name: 'P', password: 'password123' });
    const auth = { Authorization: `Bearer ${tokenFrom(res)}` };
    const bad = await request(app).put('/api/ai/feedback/policy').set(auth).send({ minCorrections: 0 });
    expect(bad.status).toBe(400);
    const ok = await request(app).put('/api/ai/feedback/policy').set(auth).send({ minSessions: 4 });
    expect(ok.body.policy).toMatchObject({ host: { minSessions: 4 }, effective: { minSessions: 4, minCorrections: 3 } });
  });
});

describe('evidence that does not count', () => {
  it('drops corrections that were undone later', () => {
    const t = (h: number) => new Date(NOW.getTime() + h * 1000);
    const rows = [
      { kind: 'task', action: 'edit', field: 'owner', itemId: 't1', sessionId: 's', before: 'A', after: 'B', at: t(1) },
      { kind: 'task', action: 'edit', field: 'owner', itemId: 't1', sessionId: 's', before: 'B', after: 'A', at: t(2) }, // undo
      { kind: 'task', action: 'add', field: null, itemId: 't9', sessionId: 's', before: null, after: { task: 'x' }, at: t(3) },
      { kind: 'task', action: 'delete', field: null, itemId: 't9', sessionId: 's', before: { task: 'x' }, after: null, at: t(4) }, // undo
      { kind: 'task', action: 'edit', field: 'dueDate', itemId: 't2', sessionId: 's', before: null, after: '2026-12-01', at: t(5) },
    ] as CorrectionRow[];
    expect(dropReverted(rows).map((r) => r.field)).toEqual(['dueDate']);
  });

  it('ignores corrections outside the window, so lessons expire unless reinforced', async () => {
    await seed([
      { sessionId: 's1', at: new Date('2026-01-01T00:00:00Z') },
      { sessionId: 's2', at: new Date('2026-01-02T00:00:00Z') },
      { sessionId: 's3', at: new Date('2026-01-03T00:00:00Z') },
    ]);
    reply = { lessons: [lesson('Stale rule', [1, 2, 3])] };
    expect(await learnLessons(HOST, fakeAi, NOW)).toBeNull();
    expect(prompts).toHaveLength(0); // nothing usable: the model isn't even asked
  });
});

describe('versioning and rollback', () => {
  it('versions every change, rolls back, and quarantines the evidence of removed lessons', async () => {
    const rows = await seed([
      { sessionId: 's1' }, { sessionId: 's2' }, { sessionId: 's3' }, // owner pattern
      { sessionId: 's4', field: 'dueDate', before: null, after: '2026-12-01' },
      { sessionId: 's5', field: 'dueDate', before: null, after: '2026-12-02' },
      { sessionId: 's6', field: 'dueDate', before: null, after: '2026-12-03' }, // deadline pattern (the bad one)
    ]);
    // newest first: rows[0..2] are the owner corrections (s1-s3), rows[3..5] the due dates.
    reply = { lessons: [lesson('Owner rule', [1, 2, 3])] };
    await learnLessons(HOST, fakeAi, NOW);
    // Same result → no new version.
    await learnLessons(HOST, fakeAi, NOW);
    expect((await doc())!.versions).toHaveLength(1);

    reply = { lessons: [lesson('Owner rule', [1, 2, 3]), lesson('Bad deadline rule', [4, 5, 6], { topic: 'deadline' })] };
    let d = await learnLessons(HOST, fakeAi, NOW);
    expect(d!.current).toBe(2);
    expect(appliedLessons(d)).toEqual(['Owner rule', 'Bad deadline rule']);

    d = await rollbackLessons(HOST, 1, 'u1', NOW);
    expect(d.current).toBe(3);
    expect(d.versions.at(-1)).toMatchObject({ source: 'rollback', fromVersion: 1 });
    expect(appliedLessons(d)).toEqual(['Owner rule']);
    const dueIds = rows.slice(3).map((r) => r._id);
    expect(await corrections().countDocuments({ _id: { $in: dueIds }, quarantinedBy: 3 })).toBe(3);

    // The next learning run does not see the quarantined corrections, so it can't re-learn the bad rule.
    reply = { lessons: [lesson('Owner rule', [1, 2, 3])] };
    await learnLessons(HOST, fakeAi, NOW);
    expect(prompts.at(-1)).not.toContain('2026-12-0');

    // Rolling forward to version 2 releases them again.
    d = await rollbackLessons(HOST, 2, 'u1', NOW);
    expect(appliedLessons(d)).toEqual(['Owner rule', 'Bad deadline rule']);
    expect(await corrections().countDocuments({ quarantinedBy: { $gt: 0 } })).toBe(0);
  });

  it('stricter thresholds demote an applied lesson right away (as a new version)', async () => {
    await seed([{ sessionId: 's1' }, { sessionId: 's2' }, { sessionId: 's3' }]);
    reply = { lessons: [lesson('Owner rule', [1, 2, 3])] };
    expect(appliedLessons(await learnLessons(HOST, fakeAi, NOW))).toEqual(['Owner rule']);
    await lessonsCol().updateOne({ _id: HOST }, { $set: { policy: { minSessions: 4 } } });
    const d = await recheckLessons(HOST, 'u1', NOW);
    expect(d!.versions.at(-1)).toMatchObject({ source: 'policy', version: 2 });
    expect(appliedLessons(d)).toEqual([]);
    // Nothing changed → no extra version.
    expect((await recheckLessons(HOST, 'u1', NOW))!.versions).toHaveLength(2);
  });

  it('marking a correction wrong re-checks lessons at once, and can be undone', async () => {
    const rows = await seed([{ sessionId: 's1' }, { sessionId: 's2' }, { sessionId: 's3' }]);
    reply = { lessons: [lesson('Owner rule', [1, 2, 3])] };
    await learnLessons(HOST, fakeAi, NOW);
    const id = String(rows[0]!._id);
    let d = await setCorrectionExcluded(HOST, id, true, 'u1', NOW);
    expect(d!.versions.at(-1)).toMatchObject({ source: 'exclude' });
    expect(d!.versions.at(-1)!.lessons[0]).toMatchObject({ status: 'candidate', support: { corrections: 2 } });
    expect(appliedLessons(d)).toEqual([]);
    expect(d!.relearnRequested).toBe(true);
    d = await setCorrectionExcluded(HOST, id, false, 'u1', NOW);
    expect(appliedLessons(d)).toEqual(['Owner rule']);
  });

  it('exposes history and rollback over the API, only for the host’s own lessons', async () => {
    const res = await request(app).post('/api/auth/register').send({ email: 'h@test.dev', name: 'H', password: 'password123' });
    const uid = res.body.user.id as string;
    const auth = { Authorization: `Bearer ${tokenFrom(res)}` };
    await corrections().insertMany(
      ['s1', 's2', 's3'].map((s, i) => ({
        hostId: uid, meetingCode: 'm', sessionId: s, kind: 'task' as const, action: 'edit' as const, field: 'owner', itemId: `t${i}`,
        before: 'A', after: 'B', evidence: [], by: uid, at: new Date(Date.now() - i * 1000),
      })),
    );
    reply = { lessons: [lesson('Owner rule', [1, 2, 3])] };
    const learned = await request(app).post('/api/ai/feedback/learn').set(auth);
    expect(learned.body.lessons[0]).toMatchObject({ status: 'active', evidenceDetail: expect.arrayContaining([expect.objectContaining({ field: 'owner' })]) });
    expect(learned.body.versions).toHaveLength(1);

    const excl = await request(app).patch(`/api/ai/feedback/corrections/${learned.body.lessons[0].evidence[0]}`).set(auth).send({ excluded: true });
    expect(excl.body).toMatchObject({ excluded: 1, current: 2 });
    const back = await request(app).post('/api/ai/feedback/rollback').set(auth).send({ version: 1 });
    expect(back.body.current).toBe(3);
    expect((await request(app).post('/api/ai/feedback/rollback').set(auth).send({ version: 99 })).status).toBe(404);
    expect((await request(app).patch('/api/ai/feedback/corrections/nope').set(auth).send({ excluded: true })).status).toBe(404);
  });
});
