/**
 * Real-model check of the conversational Jira workflow (agent/src/jira/flow.ts) against scripted conversations,
 * with an in-memory database and a fake server (no real Jira).
 *   npx tsx eval/jira-flow-check.ts
 */
import { initializeLogger } from '@livekit/agents';
import { MongoClient } from 'mongodb';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { geminiKeysFromEnv } from '../src/ai/pool.js';
import { config } from '../src/config.js';
import { geminiStructured, parseModels } from '../src/gemini.js';
import { IssueDesk, type DraftView } from '../src/jira/flow.js';
import type { ScreenState } from '../src/screen/vision.js';
import { MeetingTranscript } from '../src/transcript.js';

initializeLogger({ pretty: false, level: 'warn' });
const cfg = config();
const call = geminiStructured({ apiKeys: geminiKeysFromEnv(process.env), models: parseModels(cfg.GEMINI_MODEL, cfg.GEMINI_FALLBACK_MODELS), thinking: cfg.GEMINI_THINKING, env: process.env });
const mongo = await MongoMemoryServer.create();
const client = await MongoClient.connect(mongo.getUri());
const db = client.db('eval');

const SCREEN: ScreenState = {
  sharing: 'Ravi',
  observations: [{
    id: 'v1', at: new Date().toISOString(), sharer: 'Ravi', reason: 'change', app: 'Chrome – Acme Shop login (staging)',
    summary: 'Login page; clicking Log in throws a JavaScript error', visibleErrors: ["Uncaught TypeError: Cannot read properties of undefined (reading 'submit') at LoginForm.handleClick (login.js:42:17)"],
    keyText: ['https://staging.acme-shop.com/login', 'Log in'], focus: 'Log in button',
    issue: { suspected: true, description: 'Login button does nothing', actual: 'Nothing happens, TypeError in console', expected: '', steps: ['Enter email and password', 'Click Log in'] }, relevantToDiscussion: true,
  }],
};

let failures = 0;
const check = (name: string, ok: boolean, detail: unknown) => {
  if (!ok) failures++;
  console.log(`${ok ? '  ✓' : '  ✗'} ${name}${ok ? '' : `  → ${JSON.stringify(detail).slice(0, 400)}`}`);
};

async function conversation(title: string, steps: Array<{ who: string; text: string; expect: (r: { acted: boolean; say: string }, d: DraftView | undefined, calls: string[]) => Array<[string, boolean]> }>, screen: ScreenState | null) {
  console.log(`\n${title}`);
  const sessionId = `s-${Math.random().toString(36).slice(2)}`;
  const t = new MeetingTranscript('m', sessionId);
  const internalCalls: string[] = [];
  let shots = 0;
  const desk = new IssueDesk({
    db, call, meetingCode: 'abc-defg-hij', sessionId, hostId: () => 'host1', transcript: () => t.all, screen: () => screen,
    internal: async (path) => {
      internalCalls.push(path);
      if (path.endsWith('/create')) {
        await db.collection('issue_drafts').updateMany({ sessionId }, { $set: { status: 'created', jira: { key: 'SHOP-42', url: 'https://acme.atlassian.net/browse/SHOP-42' } } });
        return { status: 200, body: { draft: { jira: { key: 'SHOP-42', url: 'https://acme.atlassian.net/browse/SHOP-42' } } } };
      }
      return { status: 200, body: { stopped: true, recordingId: 'r1' } };
    },
    screenshot: async () => (screen ? (shots++, { name: 'screenshot.png', data: Buffer.from([137, 80, 78, 71]) }) : null),
    screenTrack: () => (screen ? { sid: 'TR_screen', sharer: 'Ravi' } : null),
    onChange: () => {},
  });
  for (const s of steps) {
    t.add({ speakerId: `guest:${s.who.toLowerCase()}`, speakerName: s.who, userId: null, isAgent: false, channel: 'voice', text: s.text, language: '', at: Date.now() });
    const line = t.all.at(-1)!;
    const tm = Date.now();
    // Like the live agent: lines that name the assistant count as addressed to it.
    const r = await desk.handle(line, { identity: line.speakerId, name: s.who, userId: null }, undefined, /maaya/i.test(s.text));
    if (r.say) t.add({ speakerId: 'agent', speakerName: 'Maaya', userId: null, isAgent: true, channel: 'voice', text: r.say, language: '', at: Date.now() });
    const d = desk.views[0];
    console.log(`  ${s.who}: ${s.text}\n    Maaya (${Date.now() - tm} ms): ${r.say || '(silent)'}`);
    for (const [name, ok] of s.expect(r, d, internalCalls)) check(name, ok, { r, d });
  }
  return { shots: () => shots };
}

await conversation('Bug from what is shown on screen', [
  { who: 'Ravi', text: 'So when I enter my details and click this login button, nothing happens. It should open the dashboard.', expect: (r) => [['not a ticket request yet', !r.acted]] },
  { who: 'Ravi', text: 'Maaya, create a Jira bug for this.', expect: (r, d) => [
    ['a bug draft is started', r.acted && d?.type === 'bug'],
    ['actual result from the screen/talk', /nothing|TypeError/i.test(String(d?.fields.actual ?? ''))],
    ['expected result from the talk', /dashboard/i.test(String(d?.fields.expected ?? ''))],
    ['environment from the screen', /staging/i.test(String(d?.fields.environment ?? ''))],
    ['asks a follow-up question', /\?/.test(r.say)],
  ] },
  { who: 'Ravi', text: "It's a major issue, every customer is blocked. It happens in Chrome.", expect: (_r, d) => [['severity recorded', /major|critical/i.test(String(d?.fields.severity ?? ''))]] },
  { who: 'Ravi', text: 'Yes, take a screenshot of the error.', expect: (_r, d) => [['screenshot attached', (d?.evidence.attachments ?? []).some((a) => a.kind === 'screenshot')]] },
  { who: 'Ravi', text: "That's everything, show me the ticket.", expect: (r, d) => [['preview shown and approval asked', d?.status === 'ready' && /\?/.test(r.say)]] },
  { who: 'Ravi', text: 'Yes, create it.', expect: (r, _d, calls) => [['created through the server', calls.some((c) => c.endsWith('/create'))], ['confirms with the key', /SHOP-42|SHOP 42/i.test(r.say)]] },
], SCREEN);

await conversation('User story: asks only for what is missing', [
  { who: 'Asha', text: 'Maaya, please create a user story: customers should be able to save their cart and come back later.', expect: (r, d) => [
    ['a story draft is started', r.acted && d?.type === 'story'],
    ['goal taken from the request', /save|cart/i.test(String(d?.fields.goal ?? d?.fields.summary ?? ''))],
    ['asks for what is missing (role, value or criteria)', /\?/.test(r.say) && !/what (do|should) (they|customers) (want|be able)/i.test(r.say)],
  ] },
  { who: 'Asha', text: "It's for returning customers, so we stop losing sales. Done means the cart is kept for 30 days and syncs across devices.", expect: (_r, d) => [
    ['role, value and acceptance criteria recorded', !!d?.fields.userRole && !!d?.fields.benefit && (d?.fields.acceptanceCriteria ?? []).length >= 1],
  ] },
  { who: 'Asha', text: 'Leave it, no attachment is needed.', expect: (_r, d) => [['no attachment noted', d?.evidence.decision === 'none']] },
], null);

await conversation('Attach later', [
  { who: 'Chen', text: 'Maaya, log a task: update the privacy policy page with the new data retention period of 90 days, by Friday, owner Chen.', expect: (r, d) => [['task started', r.acted && d?.type === 'task']] },
  { who: 'Chen', text: "I'll attach the legal document later.", expect: (_r, d) => [['attach later noted', d?.evidence.decision === 'later']] },
], null);

await client.close();
await mongo.stop();
console.log(failures ? `\n${failures} check(s) failed` : '\nALL PASS');
process.exit(failures ? 1 : 0);
