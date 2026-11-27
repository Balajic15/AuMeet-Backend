import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { tokenFrom } from './session.js';

// This file runs with enforcement on (modules are isolated per test file).
process.env.REQUIRE_EMAIL_VERIFICATION = 'true';
const { createApp } = await import('../src/app.js');
const { captureMailForTests } = await import('../src/services/mailer.js');

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

const linkToken = (text: string) => text.match(/verify-email\?token=([\w-]+)/)![1]!;

describe('email verification', () => {
  it('sends a link on sign-up, blocks creating meetings until verified, then allows it', async () => {
    const reg = await request(app).post('/api/auth/register').send({ email: 'a@test.dev', name: 'Asha', password: 'password123' });
    const auth = { Authorization: `Bearer ${tokenFrom(reg)}` };
    expect(reg.body.user.emailVerified).toBe(false);
    expect(mail).toHaveLength(1);
    expect(mail[0]!.subject).toBe('Confirm your email for AuMeet');

    const blocked = await request(app).post('/api/meetings').set(auth).send({});
    expect(blocked.status).toBe(403);
    expect(blocked.body.error).toMatch(/verify your email/i);

    const bad = await request(app).post('/api/auth/email/verify').send({ token: 'x'.repeat(40) });
    expect(bad.status).toBe(400);

    const ok = await request(app).post('/api/auth/email/verify').send({ token: linkToken(mail[0]!.text) });
    expect(ok.body).toEqual({ ok: true, email: 'a@test.dev' });
    // single use
    expect((await request(app).post('/api/auth/email/verify').send({ token: linkToken(mail[0]!.text) })).status).toBe(400);

    expect((await request(app).get('/api/auth/me').set(auth)).body.user.emailVerified).toBe(true);
    expect((await request(app).post('/api/meetings').set(auth).send({})).status).toBe(201);
  });

  it('resends a fresh link (old one stops working), and does nothing once verified', async () => {
    const reg = await request(app).post('/api/auth/register').send({ email: 'b@test.dev', name: 'Ben', password: 'password123' });
    const auth = { Authorization: `Bearer ${tokenFrom(reg)}` };
    const first = linkToken(mail[0]!.text);

    await request(app).post('/api/auth/email/resend').set(auth);
    expect(mail).toHaveLength(2);
    expect((await request(app).post('/api/auth/email/verify').send({ token: first })).status).toBe(400);
    expect((await request(app).post('/api/auth/email/verify').send({ token: linkToken(mail[1]!.text) })).status).toBe(200);

    const again = await request(app).post('/api/auth/email/resend').set(auth);
    expect(again.body.alreadyVerified).toBe(true);
    expect(mail).toHaveLength(2);
  });

  it('counts a completed password reset as verification', async () => {
    await request(app).post('/api/auth/register').send({ email: 'c@test.dev', name: 'Chen', password: 'password123' });
    mail.length = 0;
    await request(app).post('/api/auth/password/forgot').send({ email: 'c@test.dev' });
    const token = mail[0]!.text.match(/reset-password\?token=([\w-]+)/)![1]!;
    const reset = await request(app).post('/api/auth/password/reset').send({ token, password: 'newpassword1' });
    expect(reset.body.user.emailVerified).toBe(true);
  });
});
