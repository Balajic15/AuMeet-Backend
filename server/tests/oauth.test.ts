import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { cookiePair } from './session.js';
import request from 'supertest';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';

// Fake the network calls to Google; everything else (state, cookies, linking) is real.
const fetchProfile = vi.fn();
vi.mock('../src/services/oauth.js', async (orig) => ({
  ...(await orig<typeof import('../src/services/oauth.js')>()),
  fetchProfile: (...a: unknown[]) => fetchProfile(...a),
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
  fetchProfile.mockReset();
});

/** Start the flow and return the state param + cookie the browser would hold. */
async function start(returnUrl = '/abc-defg-hij') {
  const res = await request(app).get(`/api/auth/oauth/google?returnUrl=${encodeURIComponent(returnUrl)}`);
  expect(res.status).toBe(302);
  const loc = new URL(res.headers.location!);
  expect(loc.origin).toBe('https://accounts.google.com');
  expect(loc.searchParams.get('redirect_uri')).toBe('http://localhost:4200/api/auth/oauth/google/callback');
  const cookie = (res.headers['set-cookie'] as unknown as string[])[0]!.split(';')[0]!;
  return { state: loc.searchParams.get('state')!, cookie };
}


describe('oauth', () => {
  it('reports which providers are configured', async () => {
    const res = await request(app).get('/api/auth/providers');
    expect(res.body.providers).toEqual({ google: true, github: false });
  });

  it('redirects to login with an error when a provider is not configured', async () => {
    const res = await request(app).get('/api/auth/oauth/github');
    expect(res.status).toBe(302);
    expect(res.headers.location).toMatch(/^http:\/\/localhost:4200\/login\?error=/);
  });

  it('creates a new user, sets the session cookie and returns to where they started', async () => {
    fetchProfile.mockResolvedValue({ providerId: 'g-1', email: 'new@test.dev', name: 'New User' });
    const { state, cookie } = await start();

    const cb = await request(app).get(`/api/auth/oauth/google/callback?code=c&state=${state}`).set('Cookie', cookie);
    expect(cb.status).toBe(302);
    // No token in the URL at all – the session is an httpOnly cookie.
    expect(cb.headers.location).toBe('http://localhost:4200/abc-defg-hij');

    const me = await request(app).get('/api/auth/me').set('Cookie', cookiePair(cb));
    expect(me.body.user).toMatchObject({ email: 'new@test.dev', name: 'New User' });
  });

  it('links Google to an existing password account with the same email', async () => {
    const reg = await request(app).post('/api/auth/register').send({ email: 'a@test.dev', name: 'A', password: 'password123' });
    fetchProfile.mockResolvedValue({ providerId: 'g-2', email: 'a@test.dev', name: 'A from Google' });
    const { state, cookie } = await start('/');
    const cb = await request(app).get(`/api/auth/oauth/google/callback?code=c&state=${state}`).set('Cookie', cookie);
    const me = await request(app).get('/api/auth/me').set('Cookie', cookiePair(cb));
    expect(me.body.user.id).toBe(reg.body.user.id);
    expect(await mongoose.connection.db!.collection('users').countDocuments()).toBe(1);
  });

  it('rejects a callback without the matching browser cookie (login CSRF)', async () => {
    fetchProfile.mockResolvedValue({ providerId: 'g-3', email: 'x@test.dev', name: 'X' });
    const { state } = await start();
    const cb = await request(app).get(`/api/auth/oauth/google/callback?code=c&state=${state}`).set('Cookie', 'aumeet_oauth=forged');
    expect(cb.headers.location).toMatch(/\/login\?error=/);
    expect(fetchProfile).not.toHaveBeenCalled();
  });

  it('ignores open-redirect returnUrls', async () => {
    fetchProfile.mockResolvedValue({ providerId: 'g-4', email: 'y@test.dev', name: 'Y' });
    const { state, cookie } = await start('//evil.com');
    const cb = await request(app).get(`/api/auth/oauth/google/callback?code=c&state=${state}`).set('Cookie', cookie);
    expect(cb.headers.location).toBe('http://localhost:4200/');
  });
});
