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
const { ensureDefaultProfile } = await import('../src/services/aiBehaviour.js');

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
  vi.mocked(setRoomSettings).mockClear();
});

async function user(email: string) {
  const res = await request(app).post('/api/auth/register').send({ email, name: email.split('@')[0], password: 'password123' });
  return { id: res.body.user.id as string, auth: { Authorization: `Bearer ${tokenFrom(res)}` } };
}
const profiles = () => mongoose.connection.collection<{ _id: string }>('ai_profiles');

describe('AI behaviour profiles', () => {
  it('seeds the system default once and never overwrites an edited one', async () => {
    await ensureDefaultProfile();
    await profiles().updateOne({ _id: 'default' }, { $set: { name: 'Nova' } });
    await ensureDefaultProfile();
    const u = await user('a@test.dev');
    const res = await request(app).get('/api/ai/behaviour').set(u.auth);
    expect(res.body.defaults.name).toBe('Nova');
    expect(res.body.account).toEqual({});
    expect(res.body.effective.name).toBe('Nova');
  });

  it('restores a missing default instead of running without one', async () => {
    const u = await user('a@test.dev');
    const res = await request(app).get('/api/ai/behaviour').set(u.auth);
    expect(res.status).toBe(200);
    expect(res.body.defaults.limits.minGapSeconds).toBeGreaterThan(0);
    expect(await profiles().countDocuments()).toBe(1);
  });

  it('saves, validates and resets my account default', async () => {
    const u = await user('a@test.dev');
    const put = (account: unknown) => request(app).put('/api/ai/behaviour').set(u.auth).send({ account });
    const ok = await put({ tone: 'casual', talkativeness: 0.2, limits: { minGapSeconds: 180 }, customInstructions: 'Speak Hindi mostly' });
    expect(ok.status).toBe(200);
    expect(ok.body.effective).toMatchObject({ tone: 'casual', talkativeness: 0.2, customInstructions: 'Speak Hindi mostly' });
    expect(ok.body.effective.limits.minGapSeconds).toBe(180);
    expect(ok.body.effective.limits.maxPerTenMinutes).toBe(ok.body.defaults.limits.maxPerTenMinutes);

    expect((await put({ talkativeness: 3 })).status).toBe(400);
    expect((await put({ engine: { contextLines: 5 } })).status).toBe(400); // engine tuning is system-wide
    expect((await put({ somethingElse: true })).status).toBe(400);

    const reset = await put(null);
    expect(reset.body.account).toEqual({});
    expect(reset.body.effective.tone).toBe(reset.body.defaults.tone);
  });

  it('per meeting: host-only, layered on the host default, merged on edit, pushed live, resettable', async () => {
    const host = await user('host@test.dev');
    const other = await user('other@test.dev');
    await request(app).put('/api/ai/behaviour').set(host.auth).send({ account: { tone: 'formal' } });
    const m = (await request(app).post('/api/meetings').set(host.auth).send({ title: 'Sync' })).body.meeting;

    expect((await request(app).get(`/api/meetings/${m.code}/ai-behaviour`).set(other.auth)).status).toBe(403);
    expect((await request(app).patch(`/api/meetings/${m.code}`).set(other.auth).send({ aiBehaviour: { talkativeness: 1 } })).status).toBe(403);

    await request(app).patch(`/api/meetings/${m.code}`).set(host.auth).send({ aiBehaviour: { talkativeness: 0.9 } });
    await request(app).patch(`/api/meetings/${m.code}`).set(host.auth).send({ aiBehaviour: { watchFor: { time: false } } });
    expect(setRoomSettings).toHaveBeenCalledWith(m.code, expect.objectContaining({ prepVersion: expect.any(Number) }));

    const view = (await request(app).get(`/api/meetings/${m.code}/ai-behaviour`).set(host.auth)).body;
    expect(view.meeting).toEqual({ talkativeness: 0.9, watchFor: { time: false } });
    expect(view.account.tone).toBe('formal');
    expect(view.effective).toMatchObject({ tone: 'formal', talkativeness: 0.9 });
    expect(view.effective.watchFor).toMatchObject({ time: false, decisions: true });

    expect((await request(app).patch(`/api/meetings/${m.code}`).set(host.auth).send({ aiBehaviour: { limits: { pauseMs: 1 } } })).status).toBe(400);
    const replaced = await request(app).patch(`/api/meetings/${m.code}`).set(host.auth).send({ aiBehaviour: { tone: 'casual' }, aiBehaviourMode: 'replace' });
    expect(replaced.status).toBe(200);
    expect((await request(app).get(`/api/meetings/${m.code}/ai-behaviour`).set(host.auth)).body.meeting).toEqual({ tone: 'casual' });
    await request(app).patch(`/api/meetings/${m.code}`).set(host.auth).send({ aiBehaviour: null });
    expect((await request(app).get(`/api/meetings/${m.code}/ai-behaviour`).set(host.auth)).body.meeting).toBeNull();
  });

  it('shows what the AI learned from my meetings, lets me reset it, and deletes it with my account', async () => {
    const host = await user('host@test.dev');
    const other = await user('other@test.dev');
    const rows = (hostId: string) => [
      { hostId, intent: 'confirm_decision', reaction: 'engaged' },
      { hostId, intent: 'confirm_decision', reaction: 'engaged' },
      { hostId, intent: 'time_check', reaction: 'ignored' },
    ];
    await mongoose.connection.collection('ai_reactions').insertMany([...rows(host.id), ...rows(other.id)]);
    const learned = (await request(app).get('/api/ai/learning').set(host.auth)).body;
    expect(learned.total).toBe(3);
    expect(learned.stats[0]).toEqual({ intent: 'confirm_decision', engaged: 2, ignored: 0, rejected: 0 });

    expect((await request(app).delete('/api/ai/learning').set(host.auth)).body.deleted).toBe(3);
    expect((await request(app).get('/api/ai/learning').set(other.auth)).body.total).toBe(3);

    await request(app).delete('/api/auth/me').set(other.auth).send({ password: 'password123', confirmEmail: 'other@test.dev' });
    expect(await mongoose.connection.collection('ai_reactions').countDocuments()).toBe(0);
  });
});
