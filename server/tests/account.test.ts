import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { cookiePair, tokenFrom } from './session.js';

vi.mock('../src/services/livekit.js', async (orig) => ({
  ...(await orig<typeof import('../src/services/livekit.js')>()),
  closeRoom: vi.fn(async () => {}),
}));

const { createApp } = await import('../src/app.js');
const { captureMailForTests } = await import('../src/services/mailer.js');

const app = createApp();
let mongo: MongoMemoryServer;
const mail = captureMailForTests();

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

const CSRF = { 'X-AuMeet-CSRF': '1' };

async function register(email = 'a@test.dev', password = 'password123') {
  const res = await request(app).post('/api/auth/register').send({ email, name: 'Asha Rao', password });
  expect(res.status).toBe(201);
  return res;
}

describe('cookie sessions', () => {
  it('sets an httpOnly, SameSite=Lax session cookie and never returns the token in the body', async () => {
    const res = await register();
    const cookie = (res.headers['set-cookie'] as unknown as string[]).find((c) => c.startsWith('aumeet_session='))!;
    expect(cookie).toMatch(/HttpOnly/);
    expect(cookie).toMatch(/SameSite=Lax/);
    expect(res.body.token).toBeUndefined();
    expect(res.body.user).toMatchObject({ email: 'a@test.dev', hasPassword: true });

    const me = await request(app).get('/api/auth/me').set('Cookie', cookiePair(res));
    expect(me.status).toBe(200);
  });

  it('requires the CSRF header for cookie-authenticated writes', async () => {
    const res = await register();
    const blocked = await request(app).post('/api/meetings').set('Cookie', cookiePair(res)).send({ title: 'x' });
    expect(blocked.status).toBe(403);
    const ok = await request(app).post('/api/meetings').set('Cookie', cookiePair(res)).set(CSRF).send({ title: 'x' });
    expect(ok.status).toBe(201);
    // Bearer clients carry no ambient credentials, so they don't need it.
    const bearer = await request(app).post('/api/meetings').set('Authorization', `Bearer ${tokenFrom(res)}`).send({});
    expect(bearer.status).toBe(201);
  });

  it('logout clears the cookie; logout-all revokes every existing session', async () => {
    const a = await register();
    const b = await request(app).post('/api/auth/login').send({ email: 'a@test.dev', password: 'password123' });

    const out = await request(app).post('/api/auth/logout').set('Cookie', cookiePair(a)).set(CSRF);
    expect((out.headers['set-cookie'] as unknown as string[])[0]).toMatch(/aumeet_session=;/);

    await request(app).post('/api/auth/logout-all').set('Cookie', cookiePair(b)).set(CSRF);
    for (const s of [a, b]) {
      const me = await request(app).get('/api/auth/me').set('Cookie', cookiePair(s));
      expect(me.status).toBe(401);
    }
  });
});

describe('profile and passwords', () => {
  it('updates the display name', async () => {
    const a = await register();
    const res = await request(app).patch('/api/auth/me').set('Cookie', cookiePair(a)).set(CSRF).send({ name: '  Asha R.  ' });
    expect(res.body.user.name).toBe('Asha R.');
  });

  it('changes the password only with the current one, and signs out other devices', async () => {
    const a = await register();
    const other = await request(app).post('/api/auth/login').send({ email: 'a@test.dev', password: 'password123' });

    const wrong = await request(app).post('/api/auth/password/change').set('Cookie', cookiePair(a)).set(CSRF)
      .send({ currentPassword: 'nope', newPassword: 'newpassword1' });
    expect(wrong.status).toBe(400);

    const ok = await request(app).post('/api/auth/password/change').set('Cookie', cookiePair(a)).set(CSRF)
      .send({ currentPassword: 'password123', newPassword: 'newpassword1' });
    expect(ok.status).toBe(200);
    expect((await request(app).get('/api/auth/me').set('Cookie', cookiePair(ok))).status).toBe(200); // this device
    expect((await request(app).get('/api/auth/me').set('Cookie', cookiePair(other))).status).toBe(401); // others

    const login = await request(app).post('/api/auth/login').send({ email: 'a@test.dev', password: 'newpassword1' });
    expect(login.status).toBe(200);
  });

  it('resets a forgotten password with a single-use emailed link', async () => {
    await register();
    mail.length = 0; // ignore the sign-up verification email
    const unknown = await request(app).post('/api/auth/password/forgot').send({ email: 'nobody@test.dev' });
    expect(unknown.status).toBe(200);
    expect(mail).toHaveLength(0);

    await request(app).post('/api/auth/password/forgot').send({ email: 'A@test.dev' });
    expect(mail).toHaveLength(1);
    expect(mail[0]!.to).toBe('a@test.dev');
    const token = mail[0]!.text.match(/reset-password\?token=([\w-]+)/)![1]!;

    // The database only stores a hash of the token.
    const stored = await mongoose.connection.db!.collection('users').findOne({ email: 'a@test.dev' });
    expect(stored!.resetTokenHash).toBeDefined();
    expect(stored!.resetTokenHash).not.toBe(token);

    const reset = await request(app).post('/api/auth/password/reset').send({ token, password: 'brandnew123' });
    expect(reset.status).toBe(200);
    expect(tokenFrom(reset)).toBeTruthy(); // signed in
    const again = await request(app).post('/api/auth/password/reset').send({ token, password: 'another123' });
    expect(again.status).toBe(400);
    expect((await request(app).post('/api/auth/login').send({ email: 'a@test.dev', password: 'brandnew123' })).status).toBe(200);
  });
});

describe('account deletion', () => {
  it('needs confirmation, removes hosted meetings and data, and anonymises only this user elsewhere', async () => {
    const asha = await register('asha@test.dev');
    const ben = await register('ben@test.dev');
    const ashaId = asha.body.user.id as string;
    const benId = ben.body.user.id as string;

    const mine = (await request(app).post('/api/meetings').set('Cookie', cookiePair(asha)).set(CSRF).send({ title: 'Mine' })).body.meeting;
    const bens = (await request(app).post('/api/meetings').set('Cookie', cookiePair(ben)).set(CSRF).send({ title: 'Bens' })).body.meeting;
    await request(app).post(`/api/meetings/${bens.code}/join`).set('Cookie', cookiePair(asha)).set(CSRF);

    const db = mongoose.connection.db!;
    await db.collection('meeting_insights').insertMany([
      { sessionId: 's-mine', meetingCode: mine.code, insights: {} },
      { sessionId: 's-bens', meetingCode: bens.code, participantUserIds: [ashaId, benId],
        insights: { actionItems: [{ id: 't1', task: 'x', ownerUserId: ashaId, status: 'open' }] } },
    ]);
    await db.collection('transcripts').insertMany([
      { meetingCode: mine.code, sessionId: 's-mine', seq: 1, speakerName: 'Asha Rao', userId: ashaId, text: 'mine' },
      { meetingCode: bens.code, sessionId: 's-bens', seq: 1, speakerName: 'Asha Rao', userId: ashaId, text: 'hi' },
      { meetingCode: bens.code, sessionId: 's-bens', seq: 2, speakerName: 'Ben', userId: benId, text: 'hello' },
    ]);

    const noConfirm = await request(app).delete('/api/auth/me').set('Cookie', cookiePair(asha)).set(CSRF)
      .send({ confirmEmail: 'wrong@test.dev', password: 'password123' });
    expect(noConfirm.status).toBe(400);

    const del = await request(app).delete('/api/auth/me').set('Cookie', cookiePair(asha)).set(CSRF)
      .send({ confirmEmail: 'asha@test.dev', password: 'password123' });
    expect(del.status).toBe(200);
    expect(del.body.meetingsDeleted).toBe(1);

    expect(await db.collection('users').countDocuments({ email: 'asha@test.dev' })).toBe(0);
    expect(await db.collection('meetings').countDocuments({ code: mine.code })).toBe(0);
    expect(await db.collection('meeting_insights').countDocuments({ meetingCode: mine.code })).toBe(0);

    const lines = await db.collection('transcripts').find({ meetingCode: bens.code }).sort({ seq: 1 }).toArray();
    expect(lines.map((l) => [l.speakerName, l.userId])).toEqual([
      ['Former member', null],
      ['Ben', benId], // untouched
    ]);
    const s = await db.collection('meeting_insights').findOne({ sessionId: 's-bens' });
    expect(s!.participantUserIds).toEqual([benId]);
    expect(s!.insights.actionItems[0].ownerUserId).toBeNull();

    expect((await request(app).get('/api/auth/me').set('Cookie', cookiePair(asha))).status).toBe(401);
  });
});

describe('test isolation', () => {
  it('never loads the real .env (no SMTP, Gemini or Redis keys in tests)', async () => {
    const { env } = await import('../src/config/env.js');
    expect(env.SMTP_URL).toBeUndefined();
    expect(env.GOOGLE_API_KEY).toBeUndefined();
    expect(env.REDIS_URL).toBeUndefined();
    expect(env.AGENT_NAME).toBe('aumeet');
  });
});
