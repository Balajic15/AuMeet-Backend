import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { tokenFrom } from './session.js';
import { createApp } from '../src/app.js';
import { signInternal } from '../src/routes/internal.js';
import { encryptSecret } from '../src/services/secrets.js';
import { descriptionAdf } from '../src/integrations/jiraIssues.js';

vi.mock('../src/services/livekit.js', async (orig) => ({
  ...(await orig<typeof import('../src/services/livekit.js')>()),
  setRoomSettings: vi.fn(async () => {}),
  ensureAgent: vi.fn(async () => {}),
  notifyRoom: vi.fn(async () => {}),
}));

const app = createApp();
let mongo: MongoMemoryServer;
type Handler = (url: string, init: RequestInit) => { status?: number; body?: unknown };
let routes: Array<[RegExp, Handler]> = [];
const calls: Array<{ url: string; method: string; body: unknown; headers: Record<string, string> }> = [];
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
  calls.length = 0;
  routes = [];
  vi.stubGlobal('fetch', async (input: string | URL, init: RequestInit = {}) => {
    const url = String(input);
    if (url.startsWith('http://127.0.0.1')) return realFetch(input, init);
    calls.push({ url, method: init.method ?? 'GET', body: init.body, headers: (init.headers ?? {}) as Record<string, string> });
    const r = routes.find(([re]) => re.test(url));
    if (!r) return new Response(JSON.stringify({ errorMessages: ['unexpected ' + url] }), { status: 500 });
    const out = r[1](url, init);
    return new Response(out.body === undefined ? '' : JSON.stringify(out.body), { status: out.status ?? 200 });
  });
});
afterEach(() => vi.unstubAllGlobals());

const db = () => mongoose.connection.db!;

async function setup() {
  const res = await request(app).post('/api/auth/register').send({ email: 'h@test.dev', name: 'Hana', password: 'password123' });
  const host = { id: res.body.user.id as string, auth: { Authorization: `Bearer ${tokenFrom(res)}` } };
  const { code } = (await request(app).post('/api/meetings').set(host.auth).send({ title: 'Bug triage' })).body.meeting;
  await db().collection('integrations').insertOne({
    userId: host.id, provider: 'jira', status: 'connected', account: 'h@acme.dev', enabled: true,
    config: { site: 'acme.atlassian.net', projectKey: 'SHOP' }, secret: encryptSecret({ site: 'acme.atlassian.net', email: 'h@acme.dev', token: 'tok-123456' }),
  });
  await db().collection('meeting_insights').insertOne({ sessionId: 's1', meetingCode: code, startedAt: new Date(), participantUserIds: [host.id], insights: {} });
  const ins = await db().collection('issue_drafts').insertOne({
    meetingCode: code, sessionId: 's1', hostId: host.id, requestedBy: { identity: 'guest:ravi', name: 'Ravi', userId: null }, type: 'bug', status: 'ready',
    fields: {
      summary: 'Login button does nothing on staging', actual: 'Nothing happens; TypeError in login.js:42', expected: 'Go to the dashboard',
      stepsToReproduce: ['Open /login', 'Enter email and password', 'Click Log in'], environment: 'staging.acme-shop.com, Chrome', severity: 'major', priority: 'high', assignee: 'Ravi',
    },
    missing: [], evidence: { decision: 'collected', attachments: [] }, createdAt: new Date(), updatedAt: new Date(),
  });
  const draftId = String(ins.insertedId);
  await db().collection('issue_attachments').insertOne({ _id: 'att1' as never, draftId, meetingCode: code, name: 'screenshot.png', mime: 'image/png', size: 4, data: Buffer.from([1, 2, 3, 4]) });
  await db().collection('issue_drafts').updateOne({ _id: ins.insertedId }, { $push: { 'evidence.attachments': { id: 'att1', kind: 'screenshot', name: 'screenshot.png', mime: 'image/png', size: 4, status: 'ready' } } as never });
  return { host, code, draftId };
}

const jiraOk = (): Array<[RegExp, Handler]> => [
  [/createmeta\/SHOP\/issuetypes/, () => ({ body: { issueTypes: [{ name: 'Bug' }, { name: 'Story' }, { name: 'Task' }] } })],
  [/user\/search/, () => ({ body: [{ accountId: 'acc-ravi', displayName: 'Ravi' }] })],
  [/search\/jql/, () => ({ body: { issues: [] } })],
  [/\/rest\/api\/3\/issue$/, () => ({ status: 201, body: { id: '10001', key: 'SHOP-42' } })],
  [/issue\/SHOP-42\/attachments/, () => ({ body: [{ id: 'a1' }] })],
];

const internal = (path: string, body: unknown) => {
  const raw = JSON.stringify(body);
  return request(app).post(`/api/internal${path}`).set('content-type', 'application/json').set('x-aumeet-signature', signInternal(raw)).send(raw);
};

describe('creating Jira issues from meeting drafts', () => {
  it('creates once with full fields and attachments, links it to the meeting, and is idempotent', async () => {
    const { draftId } = await setup();
    routes = jiraOk();
    const r = await internal(`/issues/${draftId}/create`, { approver: { identity: 'guest:ravi', name: 'Ravi' } });
    expect(r.status).toBe(200);
    expect(r.body.draft).toMatchObject({ status: 'created', jira: { key: 'SHOP-42', url: 'https://acme.atlassian.net/browse/SHOP-42' } });
    const create = calls.find((c) => /\/rest\/api\/3\/issue$/.test(c.url))!;
    const fields = JSON.parse(String(create.body)).fields;
    expect(fields).toMatchObject({ project: { key: 'SHOP' }, issuetype: { name: 'Bug' }, priority: { name: 'High' }, assignee: { accountId: 'acc-ravi' }, labels: ['aumeet'] });
    expect(JSON.stringify(fields.description)).toContain('Steps to reproduce');
    const attach = calls.find((c) => /attachments/.test(c.url))!;
    expect(attach.headers['X-Atlassian-Token']).toBe('no-check');
    expect(attach.body).toBeInstanceOf(FormData);
    expect((await db().collection('meeting_insights').findOne({ sessionId: 's1' }))!['jiraIssues'][0]).toMatchObject({ key: 'SHOP-42' });
    // Approving again does not create a second issue.
    const again = await internal(`/issues/${draftId}/create`, { approver: { identity: 'guest:ravi' } });
    expect(again.body.draft.jira.key).toBe('SHOP-42');
    expect(calls.filter((c) => /\/rest\/api\/3\/issue$/.test(c.url))).toHaveLength(1);
  });

  it('only the requester or the host may approve, and the essentials must be there', async () => {
    const { draftId, host, code } = await setup();
    routes = jiraOk();
    expect((await internal(`/issues/${draftId}/create`, { approver: { identity: 'guest:someone-else' } })).status).toBe(403);
    await db().collection('issue_drafts').updateOne({}, { $set: { 'fields.summary': '' } });
    const r = await internal(`/issues/${draftId}/create`, { approver: { identity: 'guest:ravi' } });
    expect(r.status).toBe(422);
    expect(r.body.details.missing).toEqual(['summary']);
    // The host can approve from the panel.
    await db().collection('issue_drafts').updateOne({}, { $set: { 'fields.summary': 'Login button does nothing' } });
    const ok = await request(app).post(`/api/meetings/${code}/issues/${draftId}/create`).set(host.auth).send({});
    expect(ok.body.draft.jira.key).toBe('SHOP-42');
  });

  it('reports a likely duplicate instead of creating, until told to create anyway', async () => {
    const { draftId } = await setup();
    routes = [[/search\/jql/, () => ({ body: { issues: [{ key: 'SHOP-7', fields: { summary: 'Login button does nothing on staging environment' } }] } })], ...jiraOk()];
    const r = await internal(`/issues/${draftId}/create`, { approver: { identity: 'guest:ravi' } });
    expect(r.body.duplicates[0]).toMatchObject({ key: 'SHOP-7' });
    expect(r.body.draft.status).toBe('ready');
    const anyway = await internal(`/issues/${draftId}/create`, { approver: { identity: 'guest:ravi' }, allowDuplicate: true });
    expect(anyway.body.draft.jira.key).toBe('SHOP-42');
  });

  it('drops a field the project does not support and retries once', async () => {
    const { draftId } = await setup();
    let first = true;
    routes = [[/\/rest\/api\/3\/issue$/, () => (first ? ((first = false), { status: 400, body: { errors: { priority: 'Field cannot be set' } } }) : { status: 201, body: { id: '1', key: 'SHOP-43' } })], ...jiraOk()];
    const r = await internal(`/issues/${draftId}/create`, { approver: { identity: 'guest:ravi' } });
    expect(r.body.draft.jira.key).toBe('SHOP-43');
    const second = JSON.parse(String(calls.filter((c) => /\/rest\/api\/3\/issue$/.test(c.url))[1]!.body)).fields;
    expect(second.priority).toBeUndefined();
  });

  it('rejects unsigned or stale internal calls', async () => {
    const { draftId } = await setup();
    const raw = JSON.stringify({ approver: { identity: 'guest:ravi' } });
    expect((await request(app).post(`/api/internal/issues/${draftId}/create`).set('content-type', 'application/json').send(raw)).status).toBe(401);
    const stale = signInternal(raw, Math.floor(Date.now() / 1000) - 3600);
    expect((await request(app).post(`/api/internal/issues/${draftId}/create`).set('content-type', 'application/json').set('x-aumeet-signature', stale).send(raw)).status).toBe(401);
  });

  it('lets participants attach a file and cancel; strangers see nothing', async () => {
    const { draftId, host, code } = await setup();
    const up = await request(app).post(`/api/meetings/${code}/issues/${draftId}/attachments`).set(host.auth).attach('file', Buffer.from('log line'), 'server.log');
    expect(up.status).toBe(201);
    const list = await request(app).get(`/api/meetings/${code}/issues`).set(host.auth);
    expect(list.body.drafts[0].evidence.attachments.map((a: { name: string }) => a.name)).toEqual(['screenshot.png', 'server.log']);
    const res = await request(app).post('/api/auth/register').send({ email: 'x@test.dev', name: 'X', password: 'password123' });
    const stranger = { Authorization: `Bearer ${tokenFrom(res)}` };
    expect((await request(app).get(`/api/meetings/${code}/issues/${draftId}/attachments/att1`).set(stranger)).status).toBe(403);
    expect((await request(app).post(`/api/meetings/${code}/issues/${draftId}/cancel`).set(host.auth)).body).toEqual({ ok: true });
  });

  it('writes a story in the user-story form', () => {
    const adf = JSON.stringify(descriptionAdf('story', { userRole: 'a returning customer', goal: 'save my cart', benefit: 'I can buy later', acceptanceCriteria: ['Cart persists 30 days'] }));
    expect(adf).toContain('As a returning customer, I want save my cart, so that I can buy later.');
    expect(adf).toContain('Acceptance criteria');
  });
});
