/**
 * End-to-end check against the REAL deployment: joins a throwaway LiveKit room as a test participant, has the
 * production agent dispatched into it, types a message in the meeting chat, and waits for the AI's chat reply.
 *
 *   npx tsx eval/e2e-reply.ts "Hi, what's the plan today?"
 *
 * Uses agent/.env (LIVEKIT_*, AGENT_NAME). Room name starts with "e2e-"; delete its rows afterwards.
 */
import { Room, RoomEvent, ParticipantKind } from '@livekit/rtc-node';
import { AccessToken, RoomAgentDispatch, RoomConfiguration, RoomServiceClient } from 'livekit-server-sdk';
import { config } from '../src/config.js';
import { participantSignature } from '../src/identity.js';

const cfg = config();
const message = process.argv[2] ?? "Hi, what's the plan today?";
const room = `e2e-${Date.now().toString(36)}`;
const identity = 'guest:e2e-tester';
const name = 'Test Person';

const at = new AccessToken(cfg.LIVEKIT_API_KEY, cfg.LIVEKIT_API_SECRET, {
  identity,
  name,
  metadata: JSON.stringify({ role: 'guest', userId: null, name, sig: participantSignature(cfg.LIVEKIT_API_SECRET, identity, name, 'guest', null) }),
  ttl: '10m',
});
at.addGrant({ room, roomJoin: true, canPublish: true, canSubscribe: true, canPublishData: true });
at.roomConfig = new RoomConfiguration({
  agents: [new RoomAgentDispatch({ agentName: cfg.AGENT_NAME, metadata: JSON.stringify({ meetingCode: room, title: 'E2E test', proactive: false }) })],
});

const r = new Room();
const t0 = Date.now();
const secs = () => ((Date.now() - t0) / 1000).toFixed(1);
let agentAt = 0;
const replies: string[] = [];

r.registerTextStreamHandler('lk.chat', async (reader, from) => {
  const text = await reader.readAll();
  console.log(`[${secs()}s] chat from ${from.identity}: ${text}`);
  replies.push(text);
});
r.on(RoomEvent.ParticipantConnected, (p) => {
  if (p.kind === ParticipantKind.AGENT) {
    agentAt = Date.now();
    console.log(`[${secs()}s] agent joined as "${p.name}"`);
  }
});

await r.connect(cfg.LIVEKIT_URL, await at.toJwt(), { autoSubscribe: false, dynacast: false });
console.log(`[${secs()}s] joined room ${room}`);
for (let i = 0; i < 60 && !agentAt; i++) await new Promise((x) => setTimeout(x, 500));
if (!agentAt) {
  console.log('RESULT: FAIL – the agent never joined');
  process.exit(1);
}
await new Promise((x) => setTimeout(x, 6000)); // let it greet and settle
console.log(`[${secs()}s] sending: ${message}`);
const sentAt = Date.now();
await r.localParticipant!.sendText(message, { topic: 'lk.chat' });
for (let i = 0; i < 60 && !replies.length; i++) await new Promise((x) => setTimeout(x, 500));
console.log(replies.length ? `RESULT: PASS – replied in ${((Date.now() - sentAt) / 1000).toFixed(1)} s` : 'RESULT: FAIL – no reply within 30 s');
await r.disconnect();
await new RoomServiceClient(cfg.LIVEKIT_URL.replace(/^wss?:/, 'https:'), cfg.LIVEKIT_API_KEY, cfg.LIVEKIT_API_SECRET).deleteRoom(room).catch(() => {});
console.log(`ROOM ${room}`);
process.exit(replies.length ? 0 : 1);
