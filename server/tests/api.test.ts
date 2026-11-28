import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { tokenFrom } from './session.js';
import request from 'supertest';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { jwtDecode } from './jwtDecode.js';

// Don't call the real LiveKit API when a host ends a meeting.
vi.mock('../src/services/livekit.js', async (orig) => ({
  ...(await orig<typeof import('../src/services/livekit.js')>()),
  closeRoom: vi.fn(async () => {}),
}));

const { createApp } = await import('../src/app.js');
const { closeRoom } = await import('../src/services/livekit.js');

let mongo: MongoMemoryServer;
const app = createApp();

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

async function register(email = 'a@test.dev', name = 'Alice') {
  const res = await request(app).post('/api/auth/register').send({ email, name, password: 'password123' });
  expect(res.status).toBe(201);
  return { ...(res.body as { user: { id: string } }), token: tokenFrom(res) };
}
const bearer = (t: string) => ({ Authorization: `Bearer ${t}` });

describe('auth', () => {
  it('registers, logs in, and returns me', async () => {
    const { token, user } = await register('A@Test.dev');
    const me = await request(app).get('/api/auth/me').set(bearer(token));
    expect(me.body.user).toMatchObject({ id: user.id, email: 'a@test.dev' });

    const login = await request(app).post('/api/auth/login').send({ email: 'a@test.dev', password: 'password123' });
    expect(login.status).toBe(200);
    expect(tokenFrom(login)).toBeTruthy();
    expect(login.body.token).toBeUndefined(); // the session lives only in the httpOnly cookie
    expect(login.body.user.passwordHash).toBeUndefined();
  });

  it('rejects duplicate email, bad password, bad token, bad input', async () => {
    await register();
    const dup = await request(app).post('/api/auth/register').send({ email: 'a@test.dev', name: 'X', password: 'password123' });
    expect(dup.status).toBe(409);
    const wrong = await request(app).post('/api/auth/login').send({ email: 'a@test.dev', password: 'wrongpass' });
    expect(wrong.status).toBe(401);
    expect((await request(app).get('/api/auth/me').set(bearer('nope'))).status).toBe(401);
    const bad = await request(app).post('/api/auth/register').send({ email: 'not-an-email', name: '', password: 'short' });
    expect(bad.status).toBe(400);
    expect(bad.body.details.length).toBeGreaterThan(0);
  });
});

describe('meetings', () => {
  it('lets host, member and guest join with correct LiveKit grants', async () => {
    const host = await register('host@test.dev', 'Host');
    const created = await request(app).post('/api/meetings').set(bearer(host.token)).send({ title: 'Sprint planning' });
    expect(created.status).toBe(201);
    const { code } = created.body.meeting;
    expect(code).toMatch(/^[a-z]{3}-[a-z]{4}-[a-z]{3}$/);

    const lobby = await request(app).get(`/api/meetings/${code}`);
    expect(lobby.body.meeting).toMatchObject({ title: 'Sprint planning', hostName: 'Host', isHost: false, status: 'idle' });

    const hostJoin = await request(app).post(`/api/meetings/${code}/join`).set(bearer(host.token));
    expect(hostJoin.status).toBe(200);
    const hostGrant = jwtDecode(hostJoin.body.livekit.token);
    expect(hostGrant.sub).toBe(`user:${host.user.id}`);
    expect(hostGrant.video).toMatchObject({ room: code, roomJoin: true, roomAdmin: true, canPublishData: true });
    expect(JSON.parse(hostGrant.metadata)).toEqual({ role: 'host', userId: host.user.id, name: 'Host', sig: expect.any(String) });
    // AI is on by default → the token dispatches the agent when it creates the room.
    const dispatch = hostGrant.roomConfig?.agents?.[0];
    expect(dispatch?.agentName).toBe('aumeet');
    expect(JSON.parse(dispatch.metadata)).toEqual({ meetingCode: code, title: 'Sprint planning', proactive: true });

    const bob = await register('bob@test.dev', 'Bob');
    const bobJoin = await request(app).post(`/api/meetings/${code}/join`).set(bearer(bob.token));
    expect(bobJoin.body.participant.role).toBe('participant');
    expect(jwtDecode(bobJoin.body.livekit.token).video.roomAdmin).toBeFalsy();
    // Rejoining must not duplicate the participant record.
    await request(app).post(`/api/meetings/${code}/join`).set(bearer(bob.token));

    expect((await request(app).post(`/api/meetings/${code}/join`).send({})).status).toBe(400);
    const guest = await request(app).post(`/api/meetings/${code}/join`).send({ name: 'Guest Gina' });
    expect(guest.body.participant).toMatchObject({ name: 'Guest Gina', role: 'guest' });
    expect(guest.body.participant.identity).toMatch(/^guest:/);

    const mine = await request(app).get('/api/meetings').set(bearer(bob.token));
    expect(mine.body.meetings).toHaveLength(1);

    const doc = await mongoose.connection.db!.collection('meetings').findOne({ code });
    expect(doc!.participants).toHaveLength(3);
  });

  it('enforces host-only actions, guest policy, and ended meetings', async () => {
    const host = await register('host@test.dev', 'Host');
    const other = await register('o@test.dev', 'Other');
    const created = await request(app).post('/api/meetings').set(bearer(host.token)).send({ settings: { allowGuests: false } });
    const { code } = created.body.meeting;

    expect((await request(app).post(`/api/meetings/${code}/join`).send({ name: 'G' })).status).toBe(403);
    expect((await request(app).patch(`/api/meetings/${code}`).set(bearer(other.token)).send({ title: 'x' })).status).toBe(403);

    const patched = await request(app)
      .patch(`/api/meetings/${code}`)
      .set(bearer(host.token))
      .send({ title: 'Renamed', settings: { allowGuests: true } });
    expect(patched.body.meeting).toMatchObject({ title: 'Renamed', settings: { allowGuests: true, aiEnabled: true, aiProactive: true } });

    await request(app).patch(`/api/meetings/${code}`).set(bearer(host.token)).send({ settings: { aiProactive: false } });
    const quietAi = await request(app).post(`/api/meetings/${code}/join`).set(bearer(host.token));
    expect(JSON.parse(jwtDecode(quietAi.body.livekit.token).roomConfig.agents[0].metadata).proactive).toBe(false);

    await request(app).patch(`/api/meetings/${code}`).set(bearer(host.token)).send({ settings: { aiEnabled: false } });
    const noAi = await request(app).post(`/api/meetings/${code}/join`).set(bearer(host.token));
    expect(jwtDecode(noAi.body.livekit.token).roomConfig).toBeUndefined();

    expect((await request(app).post(`/api/meetings/${code}/end`).set(bearer(other.token))).status).toBe(403);
    const ended = await request(app).post(`/api/meetings/${code}/end`).set(bearer(host.token));
    expect(ended.body.meeting.status).toBe('ended');
    expect(closeRoom).toHaveBeenCalledWith(code);
    expect((await request(app).post(`/api/meetings/${code}/join`).set(bearer(other.token))).status).toBe(410);
  });

  it('404s on unknown or malformed codes', async () => {
    expect((await request(app).get('/api/meetings/aaa-bbbb-ccc')).status).toBe(404);
    expect((await request(app).get('/api/meetings/%24where')).status).toBe(404);
  });
});
