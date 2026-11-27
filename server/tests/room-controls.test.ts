import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { jwtDecode } from './jwtDecode.js';
import { tokenFrom } from './session.js';

const lk = vi.hoisted(() => ({
  muteParticipant: vi.fn(async () => 1),
  removeParticipant: vi.fn(async () => {}),
  dispatchAgent: vi.fn(async () => true),
  removeAgents: vi.fn(async () => 1),
  setRoomSettings: vi.fn(async () => {}),
  closeRoom: vi.fn(async () => {}),
}));
vi.mock('../src/services/livekit.js', async (orig) => ({
  ...(await orig<typeof import('../src/services/livekit.js')>()),
  ...lk,
}));

const { createApp } = await import('../src/app.js');
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
  Object.values(lk).forEach((f) => f.mockClear());
});

async function user(email: string) {
  const res = await request(app).post('/api/auth/register').send({ email, name: email.split('@')[0], password: 'password123' });
  return { id: res.body.user.id as string, auth: { Authorization: `Bearer ${tokenFrom(res)}` } };
}

describe('in-meeting controls', () => {
  it('puts the transcription choice and self-update permission into the join token', async () => {
    const host = await user('h@test.dev');
    const { code } = (await request(app).post('/api/meetings').set(host.auth).send({})).body.meeting;

    const optedOut = await request(app).post(`/api/meetings/${code}/join`).send({ name: 'Guest', transcribe: false });
    const t = jwtDecode(optedOut.body.livekit.token);
    expect(t.attributes).toEqual({ 'aumeet.transcribe': 'off' });
    expect(t.video.canUpdateOwnMetadata).toBe(true);

    const def = await request(app).post(`/api/meetings/${code}/join`).set(host.auth);
    expect(jwtDecode(def.body.livekit.token).attributes).toEqual({ 'aumeet.transcribe': 'on' });
  });

  it('lets the host lock the meeting to everyone but themselves', async () => {
    const host = await user('h@test.dev');
    const member = await user('m@test.dev');
    const { code } = (await request(app).post('/api/meetings').set(host.auth).send({})).body.meeting;
    const patched = await request(app).patch(`/api/meetings/${code}`).set(host.auth).send({ settings: { locked: true } });
    expect(patched.body.meeting.settings.locked).toBe(true);

    expect((await request(app).post(`/api/meetings/${code}/join`).set(member.auth)).status).toBe(403);
    expect((await request(app).post(`/api/meetings/${code}/join`).send({ name: 'G' })).status).toBe(403);
    expect((await request(app).post(`/api/meetings/${code}/join`).set(host.auth)).status).toBe(200);
  });

  it('only the host can mute or remove people', async () => {
    const host = await user('h@test.dev');
    const member = await user('m@test.dev');
    const { code } = (await request(app).post('/api/meetings').set(host.auth).send({})).body.meeting;
    const target = `user:${member.id}`;

    expect((await request(app).post(`/api/meetings/${code}/participants/${target}/mute`).set(member.auth).send({})).status).toBe(403);
    const mute = await request(app).post(`/api/meetings/${code}/participants/${target}/mute`).set(host.auth).send({ source: 'camera' });
    expect(mute.status).toBe(200);
    expect(lk.muteParticipant).toHaveBeenCalledWith(code, target, 'camera');

    const rm = await request(app).post(`/api/meetings/${code}/participants/${target}/remove`).set(host.auth);
    expect(rm.status).toBe(200);
    expect(lk.removeParticipant).toHaveBeenCalledWith(code, target);

    expect((await request(app).post(`/api/meetings/${code}/participants/${encodeURIComponent('../etc')}/remove`).set(host.auth)).status).toBe(404);
    expect((await request(app).post(`/api/meetings/${code}/participants/user:${host.id}/remove`).set(host.auth)).status).toBe(400);
  });

  it('applies AI on/off and proactive changes to the running meeting', async () => {
    const host = await user('h@test.dev');
    const { code } = (await request(app).post('/api/meetings').set(host.auth).send({ title: 'Live' })).body.meeting;

    await request(app).patch(`/api/meetings/${code}`).set(host.auth).send({ settings: { aiEnabled: false } });
    expect(lk.removeAgents).toHaveBeenCalledWith(code);

    await request(app).patch(`/api/meetings/${code}`).set(host.auth).send({ settings: { aiEnabled: true } });
    expect(lk.dispatchAgent).toHaveBeenCalledWith(code, { meetingTitle: 'Live', proactive: true });

    await request(app).patch(`/api/meetings/${code}`).set(host.auth).send({ settings: { aiProactive: false } });
    expect(lk.setRoomSettings).toHaveBeenCalledWith(code, { aiProactive: false });

    // Unrelated edits don't touch the AI.
    lk.dispatchAgent.mockClear();
    lk.removeAgents.mockClear();
    await request(app).patch(`/api/meetings/${code}`).set(host.auth).send({ title: 'Renamed' });
    expect(lk.dispatchAgent).not.toHaveBeenCalled();
    expect(lk.removeAgents).not.toHaveBeenCalled();
  });
});
