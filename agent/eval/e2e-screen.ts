/**
 * End-to-end check of screen understanding with a REAL screen-share stream: joins a throwaway room, allows the AI to
 * see the screen, publishes a PNG as a screen-share video track, waits for the AI's screen observation, then asks
 * in chat what is wrong.
 *   AGENT_NAME=aumeet-dev npx tsx eval/e2e-screen.ts path/to/screen.png "Maaya, what's wrong on my screen?"
 */
import { readFileSync } from 'node:fs';
import { inflateSync } from 'node:zlib';
import {
  LocalVideoTrack, ParticipantKind, Room, RoomEvent, TrackPublishOptions, TrackSource, VideoBufferType, VideoFrame, VideoSource,
} from '@livekit/rtc-node';
import { AccessToken, RoomAgentDispatch, RoomConfiguration, RoomServiceClient } from 'livekit-server-sdk';
import { config } from '../src/config.js';
import { participantSignature } from '../src/identity.js';

/** Minimal PNG decoder (8-bit RGB/RGBA, no interlace) – enough for browser screenshots. */
function decodePng(buf: Buffer): { data: Uint8Array; width: number; height: number } {
  let pos = 8;
  let width = 0, height = 0, colorType = 0;
  const idat: Buffer[] = [];
  while (pos < buf.length) {
    const len = buf.readUInt32BE(pos);
    const type = buf.toString('ascii', pos + 4, pos + 8);
    const data = buf.subarray(pos + 8, pos + 8 + len);
    if (type === 'IHDR') { width = data.readUInt32BE(0); height = data.readUInt32BE(4); colorType = data[9]!; }
    if (type === 'IDAT') idat.push(data);
    pos += 12 + len;
  }
  const bpp = colorType === 6 ? 4 : 3;
  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * bpp;
  const out = new Uint8Array(width * height * 4);
  const prev = new Uint8Array(stride);
  const cur = new Uint8Array(stride);
  for (let y = 0; y < height; y++) {
    const f = raw[y * (stride + 1)]!;
    for (let x = 0; x < stride; x++) {
      const v = raw[y * (stride + 1) + 1 + x]!;
      const a = x >= bpp ? cur[x - bpp]! : 0;
      const b = prev[x]!;
      const c = x >= bpp ? prev[x - bpp]! : 0;
      const pa = Math.abs(b - c), pb = Math.abs(a - c), pc = Math.abs(a + b - 2 * c);
      cur[x] = (v + (f === 1 ? a : f === 2 ? b : f === 3 ? (a + b) >> 1 : f === 4 ? (pa <= pb && pa <= pc ? a : pb <= pc ? b : c) : 0)) & 255;
    }
    for (let x = 0; x < width; x++) {
      out.set([cur[x * bpp]!, cur[x * bpp + 1]!, cur[x * bpp + 2]!, bpp === 4 ? cur[x * bpp + 3]! : 255], (y * width + x) * 4);
    }
    prev.set(cur);
  }
  return { data: out, width, height };
}

const cfg = config();
const [file, question = "Maaya, can you see my screen? What's going wrong?"] = process.argv.slice(2);
const img = decodePng(readFileSync(file!));
const room = `e2e-screen-${Date.now().toString(36)}`;
const identity = 'guest:e2e-presenter';
const name = 'Ravi';
const at = new AccessToken(cfg.LIVEKIT_API_KEY, cfg.LIVEKIT_API_SECRET, {
  identity, name, ttl: '10m',
  metadata: JSON.stringify({ role: 'guest', userId: null, name, sig: participantSignature(cfg.LIVEKIT_API_SECRET, identity, name, 'guest', null) }),
  attributes: { 'aumeet.screenAi': 'on', 'aumeet.transcribe': 'on' },
});
at.addGrant({ room, roomJoin: true, canPublish: true, canSubscribe: true, canPublishData: true, canUpdateOwnMetadata: true });
at.roomConfig = new RoomConfiguration({
  agents: [new RoomAgentDispatch({ agentName: cfg.AGENT_NAME, metadata: JSON.stringify({ meetingCode: room, title: 'Bug triage', proactive: false }) })],
});

const r = new Room();
const t0 = Date.now();
const secs = () => ((Date.now() - t0) / 1000).toFixed(1);
let agentIn = false;
let observation: { app: string; summary: string; visibleErrors: string[] } | null = null;
const replies: string[] = [];
r.on(RoomEvent.ParticipantConnected, (p) => {
  if (p.kind === ParticipantKind.AGENT) {
    agentIn = true;
    console.log(`[${secs()}s] agent joined as "${p.name}"`);
  }
});
r.registerTextStreamHandler('aumeet.insights', async (reader) => {
  const msg = JSON.parse(await reader.readAll());
  const o = msg.insights?.screen?.observations?.at(-1);
  if (o && !observation) {
    observation = o;
    console.log(`[${secs()}s] AI saw: ${o.app} – ${o.summary}\n         errors: ${o.visibleErrors.join(' | ')}`);
  }
});
r.registerTextStreamHandler('lk.chat', async (reader) => {
  const text = await reader.readAll();
  console.log(`[${secs()}s] AI replied: ${text}`);
  replies.push(text);
});

await r.connect(cfg.LIVEKIT_URL, await at.toJwt(), { autoSubscribe: false, dynacast: false });
const source = new VideoSource(img.width, img.height);
const track = LocalVideoTrack.createVideoTrack('screen', source);
const opts = new TrackPublishOptions();
opts.source = TrackSource.SOURCE_SCREENSHARE;
await r.localParticipant!.publishTrack(track, opts);
console.log(`[${secs()}s] presenting ${img.width}×${img.height} on screen share`);
const frame = new VideoFrame(img.data, img.width, img.height, VideoBufferType.RGBA);
const pump = setInterval(() => source.captureFrame(frame), 250);

const wait = async (cond: () => boolean, s: number) => {
  for (let i = 0; i < s * 2 && !cond(); i++) await new Promise((x) => setTimeout(x, 500));
  return cond();
};
const ok1 = (await wait(() => agentIn, 40)) && (await wait(() => !!observation, 60));
if (ok1) {
  await r.localParticipant!.sendText(question, { topic: 'lk.chat' });
  console.log(`[${secs()}s] asked: ${question}`);
  await wait(() => replies.length > 0, 40);
}
clearInterval(pump);
await r.disconnect();
await new RoomServiceClient(cfg.LIVEKIT_URL.replace(/^wss?:/, 'https:'), cfg.LIVEKIT_API_KEY, cfg.LIVEKIT_API_SECRET).deleteRoom(room).catch(() => {});
const pass = !!observation && replies.some((x) => /TypeError|submit|login|log in/i.test(x));
console.log(pass ? 'RESULT: PASS' : `RESULT: FAIL (observation: ${!!observation}, replies: ${replies.length})`);
console.log(`ROOM ${room}`);
process.exit(pass ? 0 : 1);
