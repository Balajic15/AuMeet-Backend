import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { tokenFrom } from './session.js';
import { createApp } from '../src/app.js';
import { captureMailForTests } from '../src/services/mailer.js';
import { FollowActionModel } from '../src/models/FollowAction.js';
import { executeAction, reportTaskProgress, runDueActions } from '../src/services/followThrough.js';
import { buildMime } from '../src/integrations/google.js';
import { encryptSecret, decryptSecret } from '../src/services/secrets.js';

vi.mock('../src/services/livekit.js', async (orig) => ({
  ...(await orig<typeof import('../src/services/livekit.js')>()),
  setRoomSettings: vi.fn(async () => {}),
  ensureAgent: vi.fn(async () => {}),
  closeRoom: vi.fn(async () => {}),
  removeAgents: vi.fn(async () => {}),
}));

const app = createApp();
const mail = captureMailForTests();
let mongo: MongoMemoryServer;

/** Fake provider APIs: answer by URL, record every call. */
type Handler = (url: string, init: RequestInit) => { status?: number; body?: unknown };
let routes: Array<[RegExp, Handler]> = [];
const calls: Array<{ url: string; method: string; body: string; headers: Record<string, string> }> = [];
const realFetch = globalThis.fetch;

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
  calls.length = 0;
  routes = [];
  vi.stubGlobal('fetch', async (input: string | URL, init: RequestInit = {}) => {
    const url = String(input);
    if (url.startsWith('http://127.0.0.1')) return realFetch(input, init); // supertest
    calls.push({ url, method: init.method ?? 'GET', body: String(init.body ?? ''), headers: (init.headers ?? {}) as Record<string, string> });
    const r = routes.find(([re]) => re.test(url));
    if (!r) return new Response(JSON.stringify({ error: 'unexpected ' + url }), { status: 500 });
    const out = r[1](url, init);
    return new Response(out.body === undefined ? '' : JSON.stringify(out.body), { status: out.status ?? 200 });
  });
});
afterEach(() => vi.unstubAllGlobals());

const db = () => mongoose.connection.db!;
async function user(email: string, name: string) {
  const res = await request(app).post('/api/auth/register').send({ email, name, password: 'password123' });
  await db().collection('users').updateOne({ email }, { $set: { emailVerified: true } });
  mail.length = 0; // sign-up confirmation
  return { id: res.body.user.id as string, auth: { Authorization: `Bearer ${tokenFrom(res)}` }, cookie: res.headers['set-cookie'] as unknown as string[] };
}

describe('credential storage', () => {
  it('encrypts with authentication and never returns secrets', async () => {
    const enc = encryptSecret({ token: 'super-secret-token' });
    expect(enc).not.toContain('super-secret');
    expect(decryptSecret(enc)).toEqual({ token: 'super-secret-token' });
    const tampered = enc.slice(0, -2) + (enc.endsWith('A') ? 'B' : 'A') + enc.slice(-1);
    expect(() => decryptSecret(tampered)).toThrow();

    const u = await user('a@test.dev', 'Ana');
    routes = [[/api\.linear\.app/, () => ({ body: { data: { viewer: { name: 'Ana', email: 'ana@acme.dev' } } } })]];
    const r = await request(app).post('/api/integrations/linear/connect').set(u.auth).send({ apiKey: 'lin_api_supersecretkey' });
    expect(r.status).toBe(200);
    expect(JSON.stringify(r.body)).not.toContain('supersecret');
    expect(r.body.integrations.find((i: { provider: string }) => i.provider === 'linear')).toMatchObject({ connected: true, account: 'ana@acme.dev' });
    const stored = await db().collection('integrations').findOne({ provider: 'linear' });
    expect(String(stored!['secret'])).not.toContain('supersecret');
    expect(calls[0]!.headers['Authorization']).toBe('lin_api_supersecretkey');
  });

  it('rejects bad credentials and foreign Jira hosts', async () => {
    const u = await user('b@test.dev', 'Ben');
    routes = [[/acme\.atlassian\.net\/rest\/api\/3\/myself/, () => ({ status: 401, body: { message: 'Unauthorized' } })]];
    const bad = await request(app).post('/api/integrations/jira/connect').set(u.auth).send({ site: 'acme.atlassian.net', email: 'b@acme.dev', token: 'wrong-token-123' });
    expect(bad.status).toBe(400);
    expect(bad.body.message ?? bad.body.error).toMatch(/401/);
    const evil = await request(app).post('/api/integrations/jira/connect').set(u.auth).send({ site: 'evil.example.com', email: 'b@acme.dev', token: 'whatever-123' });
    expect(evil.status).toBe(400);
    expect(calls.some((c) => c.url.includes('evil'))).toBe(false);
  });
});

describe('Google (Gmail + Calendar)', () => {
  it('connects through OAuth bound to the signed-in user, then sends follow-ups from Gmail', async () => {
    const u = await user('h@test.dev', 'Hana');
    const start = await request(app).get('/api/integrations/google/start').set(u.auth);
    expect(start.status).toBe(302);
    const auth = new URL(start.headers['location']!);
    expect(auth.searchParams.get('scope')).toContain('gmail.send');
    expect(auth.searchParams.get('access_type')).toBe('offline');
    const state = auth.searchParams.get('state')!;
    const nonce = /aumeet_int=([^;]+)/.exec(String(start.headers['set-cookie']))![1]!;

    routes = [
      [/oauth2\.googleapis\.com\/token/, () => ({ body: { access_token: 'ya29', refresh_token: '1//refresh', expires_in: 3600, scope: 'openid email https://www.googleapis.com/auth/gmail.send https://www.googleapis.com/auth/calendar.events' } })],
      [/openidconnect\.googleapis\.com/, () => ({ body: { email: 'hana@gmail.com' } })],
      [/gmail\.googleapis\.com/, () => ({ body: { id: 'msg1' } })],
      [/calendar\/v3\/calendars\/primary\/events/, () => ({ body: { id: 'ev1', htmlLink: 'https://calendar.google.com/ev1' } })],
    ];
    // Someone else's state is refused.
    const other = await user('x@test.dev', 'X');
    const stolen = await request(app).get(`/api/integrations/google/callback?code=c&state=${state}`).set(other.auth).set('Cookie', `aumeet_int=${nonce}`);
    expect(stolen.headers['location']).toContain('error=');
    const cb = await request(app).get(`/api/integrations/google/callback?code=c&state=${state}`).set(u.auth).set('Cookie', `aumeet_int=${nonce}`);
    expect(cb.headers['location']).toContain('connected=hana%40gmail.com');

    const ravi = { userId: 'r1', name: 'Ravi', email: 'ravi@test.dev' };
    const email = await FollowActionModel.create({ sessionId: 's', meetingCode: 'abc-defg-hij', hostId: u.id, kind: 'email', status: 'approved', title: 'Your task', body: 'Hi Ravi', recipients: [ravi] });
    const done = await executeAction(String(email._id));
    expect(done).toMatchObject({ status: 'done', channel: 'gmail' });
    expect(mail).toHaveLength(0); // not through SMTP
    const raw = Buffer.from(JSON.parse(calls.find((c) => c.url.includes('gmail'))!.body).raw, 'base64url').toString();
    expect(raw).toContain('From: Hana <hana@gmail.com>');
    expect(raw).toContain('To: <ravi@test.dev>');

    const ev = await FollowActionModel.create({ sessionId: 's', meetingCode: 'abc-defg-hij', hostId: u.id, kind: 'calendar', status: 'approved', title: 'Settle pricing', body: 'Decide', when: new Date('2026-12-01T15:00:00Z'), durationMinutes: 30, recipients: [ravi] });
    expect(await executeAction(String(ev._id))).toMatchObject({ status: 'done', channel: 'google_calendar' });
    const evCall = calls.find((c) => c.url.includes('calendar/v3'))!;
    expect(evCall.url).toContain('sendUpdates=all');
    expect(JSON.parse(evCall.body)).toMatchObject({ id: `aumeet${String(ev._id)}`, attendees: [{ email: 'ravi@test.dev' }] });
  });

  it('keeps header injection out of emails', () => {
    const mime = buildMime({ from: 'a@b.c', to: 'x@y.z>\r\nBcc: evil@e.vil', subject: 'Hi\r\nBcc: evil@e.vil', text: 'body' });
    expect(mime).not.toMatch(/\r\nBcc:/);
  });
});

describe('project tools', () => {
  async function linearHost() {
    const u = await user('l@test.dev', 'Lee');
    routes = [
      [/api\.linear\.app/, (_u, init) => {
        const q = JSON.parse(String(init.body)).query as string;
        if (q.includes('viewer')) return { body: { data: { viewer: { name: 'Lee', email: 'lee@acme.dev' } } } };
        if (q.includes('teams')) return { body: { data: { teams: { nodes: [{ id: 'team1', name: 'Core', key: 'CORE' }] } } } };
        if (q.includes('issueCreate')) return { body: { data: { issueCreate: { success: true, issue: { id: 'iss1', identifier: 'CORE-7', url: 'https://linear.app/acme/issue/CORE-7' } } } } };
        if (q.includes('workflowStates')) return { body: { data: { workflowStates: { nodes: [{ id: 'st-done', position: 1 }] } } } };
        if (q.includes('issueUpdate')) return { body: { data: { issueUpdate: { success: true } } } };
        return { status: 400, body: { errors: [{ message: 'unknown' }] } };
      }],
    ];
    await request(app).post('/api/integrations/linear/connect').set(u.auth).send({ apiKey: 'lin_api_abcdefghij' }).expect(200);
    const ch = await request(app).get('/api/integrations/linear/choices').set(u.auth);
    expect(ch.body.choices).toEqual([{ id: 'team1', name: 'Core (CORE)' }]);
    await request(app).put('/api/integrations/linear/config').set(u.auth).send({ teamId: 'team1' }).expect(200);
    return u;
  }

  it('creates the issue once, links it to the task, and closes it when the task is done', async () => {
    const u = await linearHost();
    const { code } = (await request(app).post('/api/meetings').set(u.auth).send({ title: 'Plan' })).body.meeting;
    await db().collection('meeting_insights').insertOne({
      sessionId: 's1', meetingCode: code, endedAt: new Date(),
      insights: { actionItems: [{ id: 't1', task: 'Write the spec', owner: 'Lee', ownerUserId: u.id, dueDate: '2026-12-05', status: 'open' }] },
    });
    const a = await FollowActionModel.create({ sessionId: 's1', meetingCode: code, hostId: u.id, kind: 'task_sync', status: 'approved', title: 'Write the spec', taskId: 't1' });
    expect(await executeAction(String(a._id))).toMatchObject({ status: 'done', external: { key: 'CORE-7' } });
    const create = calls.find((c) => c.body.includes('issueCreate'))!;
    expect(JSON.parse(create.body).variables.input).toMatchObject({ teamId: 'team1', title: 'Write the spec', dueDate: '2026-12-05' });
    const s = await db().collection('meeting_insights').findOne({ sessionId: 's1' });
    expect(s!['insights'].actionItems[0].external).toMatchObject({ provider: 'linear', key: 'CORE-7' });

    await reportTaskProgress(code, 's1', { ...s!['insights'].actionItems[0] }, 'done');
    expect(calls.some((c) => c.body.includes('issueUpdate') && c.body.includes('st-done'))).toBe(true);
  });

  it('retries temporary failures with backoff, never duplicating the issue, then gives up', async () => {
    const u = await linearHost();
    let fail = 2;
    const issueCalls = () => calls.filter((c) => c.body.includes('issueCreate')).length;
    routes.unshift([/api\.linear\.app/, (_u, init) => {
      if (String(init.body).includes('issueCreate') && fail-- > 0) return { status: 503, body: { errors: [{ message: 'overloaded' }] } };
      return routes[1]![1](_u, init);
    }]);
    const a = await FollowActionModel.create({ sessionId: 's', meetingCode: 'abc-defg-hij', hostId: u.id, kind: 'task_sync', status: 'approved', title: 'Task' });
    const t0 = new Date('2026-11-28T10:00:00Z');
    let r = await executeAction(String(a._id), t0);
    expect(r).toMatchObject({ status: 'approved', attempts: 1, error: expect.stringContaining('503') });
    expect(await runDueActions(new Date(t0.getTime() + 10_000))).toBe(0); // backoff not over
    await runDueActions(new Date(t0.getTime() + 61_000)); // 2nd attempt fails again
    await runDueActions(new Date(t0.getTime() + 4 * 60_000)); // 3rd succeeds
    r = await FollowActionModel.findById(a._id).lean();
    expect(r).toMatchObject({ status: 'done', attempts: 3 });
    expect(issueCalls()).toBe(3);
    // Executing again does nothing (already done) – no duplicate issue.
    expect(await executeAction(String(a._id))).toBeNull();
    expect(issueCalls()).toBe(3);

    // Permanent refusals fail at once.
    routes.unshift([/api\.linear\.app/, () => ({ status: 400, body: { errors: [{ message: 'Team not found' }] } })]);
    const b = await FollowActionModel.create({ sessionId: 's', meetingCode: 'abc-defg-hij', hostId: u.id, kind: 'task_sync', status: 'approved', title: 'Other' });
    expect(await executeAction(String(b._id))).toMatchObject({ status: 'failed', attempts: 1 });
    // The host can retry a failed action by hand.
    const { code } = (await request(app).post('/api/meetings').set(u.auth).send({ title: 'X' })).body.meeting;
    await FollowActionModel.updateOne({ _id: b._id }, { $set: { meetingCode: code, sessionId: 's9' } });
    await db().collection('meeting_insights').insertOne({ sessionId: 's9', meetingCode: code, endedAt: new Date(), insights: {} });
    routes.shift();
    const retried = await request(app).post(`/api/meetings/${code}/insights/s9/actions/${String(b._id)}/retry`).set(u.auth);
    expect(retried.body.action).toMatchObject({ status: 'done', external: { key: 'CORE-7' } });
  });

  it('a retry after a partial send does not email the same person twice', async () => {
    const u = await user('m@test.dev', 'Mo');
    const a = await FollowActionModel.create({
      sessionId: 's', meetingCode: 'abc-defg-hij', hostId: u.id, kind: 'email', status: 'approved', title: 'Hi', body: 'x',
      recipients: [{ userId: 'u1', email: 'one@test.dev' }, { userId: 'u2', email: 'two@test.dev' }], sentTo: ['u1'],
    });
    await executeAction(String(a._id));
    expect(mail.map((m) => m.to)).toEqual(['two@test.dev']);
  });
});
