import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { jwtDecode } from './jwtDecode.js';
import { tokenFrom } from './session.js';
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

async function user(email: string, name: string) {
  const res = await request(app).post('/api/auth/register').send({ email, name, password: 'password123' });
  return { id: res.body.user.id as string, auth: { Authorization: `Bearer ${tokenFrom(res)}` } };
}

async function setup() {
  const host = await user('h@test.dev', 'Host');
  const { code } = (await request(app).post('/api/meetings').set(host.auth).send({ settings: { waitingRoom: true } })).body.meeting;
  return { host, code };
}

describe('waiting room', () => {
  it('makes guests ask, lets the host admit them, and hands out the token exactly once', async () => {
    const { host, code } = await setup();

    const ask = await request(app).post(`/api/meetings/${code}/join`).send({ name: 'Priya', transcribe: false });
    expect(ask.status).toBe(202);
    expect(ask.body).toMatchObject({ waiting: true });
    const { requestId, secret } = ask.body;
    const poll = () => request(app).get(`/api/meetings/${code}/join-requests/${requestId}`).query({ secret });

    expect((await poll()).body).toEqual({ status: 'pending' });

    const list = await request(app).get(`/api/meetings/${code}/join-requests`).set(host.auth);
    expect(list.body.requests).toMatchObject([{ requestId, name: 'Priya', guest: true }]);

    expect((await request(app).post(`/api/meetings/${code}/join-requests/${requestId}`).set(host.auth).send({ action: 'admit' })).status).toBe(200);

    const admitted = await poll();
    expect(admitted.body.status).toBe('admitted');
    expect(admitted.body.participant).toMatchObject({ name: 'Priya', role: 'guest' });
    // The lobby choice (don't transcribe me) survives the wait.
    expect(jwtDecode(admitted.body.livekit.token).attributes).toEqual({ 'aumeet.transcribe': 'off' });

    expect((await poll()).status).toBe(410); // single use
    expect((await request(app).get(`/api/meetings/${code}/join-requests`).set(host.auth)).body.requests).toEqual([]);
  });

  it('lets the host deny someone, and skips the queue for the host', async () => {
    const { host, code } = await setup();
    const member = await user('m@test.dev', 'Member');

    const ask = await request(app).post(`/api/meetings/${code}/join`).set(member.auth);
    expect(ask.status).toBe(202);
    await request(app).post(`/api/meetings/${code}/join-requests/${ask.body.requestId}`).set(host.auth).send({ action: 'deny' });
    const res = await request(app).get(`/api/meetings/${code}/join-requests/${ask.body.requestId}`).query({ secret: ask.body.secret });
    expect(res.body).toEqual({ status: 'denied' });

    const hostJoin = await request(app).post(`/api/meetings/${code}/join`).set(host.auth);
    expect(hostJoin.status).toBe(200);
    expect(hostJoin.body.livekit.token).toBeTruthy();
  });

  it('rejects wrong secrets and non-hosts', async () => {
    const { code } = await setup();
    const other = await user('o@test.dev', 'Other');
    const ask = await request(app).post(`/api/meetings/${code}/join`).send({ name: 'G' });

    expect((await request(app).get(`/api/meetings/${code}/join-requests/${ask.body.requestId}`).query({ secret: 'guess' })).status).toBe(404);
    expect((await request(app).get(`/api/meetings/${code}/join-requests`).set(other.auth)).status).toBe(403);
    expect((await request(app).post(`/api/meetings/${code}/join-requests/${ask.body.requestId}`).set(other.auth).send({ action: 'admit' })).status).toBe(403);
  });
});
