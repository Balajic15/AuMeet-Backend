/**
 * End-to-end check of the conversational Jira workflow in a REAL room: a test participant asks the agent (via chat)
 * for a bug ticket, answers its questions, and approves; the live draft must appear in the notes broadcast and the
 * approval must reach the server. Without a connected Jira the server answers that Jira isn't connected.
 *   AGENT_NAME=aumeet-dev npx tsx eval/e2e-jira.ts
 */
import { ParticipantKind, Room, RoomEvent } from '@livekit/rtc-node';
import { AccessToken, RoomAgentDispatch, RoomConfiguration, RoomServiceClient } from 'livekit-server-sdk';
import { config } from '../src/config.js';
import { participantSignature } from '../src/identity.js';

const cfg = config();
const room = `e2e-jira-${Date.now().toString(36)}`;
const identity = 'guest:e2e-ravi';
const name = 'Ravi';
const at = new AccessToken(cfg.LIVEKIT_API_KEY, cfg.LIVEKIT_API_SECRET, {
  identity, name, ttl: '10m',
  metadata: JSON.stringify({ role: 'guest', userId: null, name, sig: participantSignature(cfg.LIVEKIT_API_SECRET, identity, name, 'guest', null) }),
});
at.addGrant({ room, roomJoin: true, canPublish: true, canSubscribe: true, canPublishData: true });
at.roomConfig = new RoomConfiguration({ agents: [new RoomAgentDispatch({ agentName: cfg.AGENT_NAME, metadata: JSON.stringify({ meetingCode: room, title: 'Bug triage', proactive: false }) })] });

const r = new Room();
const t0 = Date.now();
const secs = () => ((Date.now() - t0) / 1000).toFixed(1);
let agentIn = false;
let draft: { type: string; status: string; fields: Record<string, unknown>; evidence: { decision: string } } | null = null;
const replies: string[] = [];
r.on(RoomEvent.ParticipantConnected, (p) => {
  if (p.kind === ParticipantKind.AGENT) agentIn = true;
});
r.registerTextStreamHandler('aumeet.insights', async (reader) => {
  const msg = JSON.parse(await reader.readAll());
  const d = msg.insights?.issues?.[0];
  if (d) draft = d;
});
r.registerTextStreamHandler('lk.chat', async (reader) => {
  const text = await reader.readAll();
  replies.push(text);
  console.log(`[${secs()}s] Maaya: ${text}`);
});
const wait = async (cond: () => boolean, s: number) => {
  for (let i = 0; i < s * 2 && !cond(); i++) await new Promise((x) => setTimeout(x, 500));
  return cond();
};
const say = async (text: string) => {
  const n = replies.length;
  console.log(`[${secs()}s] Ravi: ${text}`);
  await r.localParticipant!.sendText(text, { topic: 'lk.chat' });
  await wait(() => replies.length > n, 45);
};

await r.connect(cfg.LIVEKIT_URL, await at.toJwt(), { autoSubscribe: false, dynacast: false });
const ok = await wait(() => agentIn, 40);
if (ok) {
  await new Promise((x) => setTimeout(x, 4000));
  await say('Maaya, create a Jira bug: the login button on staging does nothing when I click it, it should open the dashboard.');
  await say("It's major, it happens in Chrome on staging.acme-shop.com. No attachment needed.");
  await say('Yes, create it.');
  await new Promise((x) => setTimeout(x, 2000));
}
await r.disconnect();
await new RoomServiceClient(cfg.LIVEKIT_URL.replace(/^wss?:/, 'https:'), cfg.LIVEKIT_API_KEY, cfg.LIVEKIT_API_SECRET).deleteRoom(room).catch(() => {});
const d = draft as typeof draft;
console.log(`draft: ${JSON.stringify(d)?.slice(0, 600)}`);
const pass = !!d && d.type === 'bug' && /login/i.test(String(d.fields['summary'] ?? '')) && replies.length >= 3 && /jira/i.test(replies.at(-1) ?? '');
console.log(pass ? 'RESULT: PASS' : 'RESULT: FAIL');
console.log(`ROOM ${room}`);
process.exit(pass ? 0 : 1);
