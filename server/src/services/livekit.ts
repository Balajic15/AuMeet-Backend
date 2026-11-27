import {
  AccessToken,
  AgentDispatchClient,
  RoomAgentDispatch,
  RoomConfiguration,
  RoomServiceClient,
  TrackSource,
} from 'livekit-server-sdk';
import { env } from '../config/env.js';
import { logger } from '../logger.js';

/** ParticipantInfo.Kind.AGENT in the LiveKit protocol. */
const AGENT_KIND = 4;

export type ParticipantRole = 'host' | 'participant' | 'guest';

export interface ParticipantMetadata {
  role: ParticipantRole;
  userId: string | null;
}

/** Participant attribute the agent honours: 'off' = don't transcribe or analyse this person. */
export const TRANSCRIBE_ATTR = 'aumeet.transcribe';

export interface AgentDispatchInfo {
  meetingTitle: string;
  proactive: boolean;
}

function dispatchMetadata(roomName: string, d: AgentDispatchInfo): string {
  return JSON.stringify({ meetingCode: roomName, title: d.meetingTitle, proactive: d.proactive });
}

/**
 * Mint a LiveKit access token for a browser participant.
 * The room name is the meeting code. Identity is stable per account so
 * the AI agent can map speech back to a known participant.
 */
export async function createParticipantToken(opts: {
  roomName: string;
  identity: string;
  name: string;
  metadata: ParticipantMetadata;
  /** Privacy opt-out chosen in the lobby. */
  transcribe?: boolean;
  /** When set, LiveKit dispatches the AI agent as the room is created by this token. */
  agentDispatch?: AgentDispatchInfo;
}): Promise<string> {
  const at = new AccessToken(env.LIVEKIT_API_KEY, env.LIVEKIT_API_SECRET, {
    identity: opts.identity,
    name: opts.name,
    metadata: JSON.stringify(opts.metadata),
    attributes: { [TRANSCRIBE_ATTR]: opts.transcribe === false ? 'off' : 'on' },
    ttl: '6h',
  });

  at.addGrant({
    room: opts.roomName,
    roomJoin: true,
    canPublish: true,
    canSubscribe: true,
    canPublishData: true, // chat, reactions, captions
    // Raise hand and the transcription opt-out are participant attributes the user sets.
    canUpdateOwnMetadata: true,
    roomAdmin: opts.metadata.role === 'host',
  });

  if (opts.agentDispatch) {
    at.roomConfig = new RoomConfiguration({
      agents: [new RoomAgentDispatch({ agentName: env.AGENT_NAME, metadata: dispatchMetadata(opts.roomName, opts.agentDispatch) })],
    });
  }

  return at.toJwt();
}

const httpUrl = () => env.LIVEKIT_URL.replace(/^ws/, 'http'); // server APIs want http(s)

let roomService: RoomServiceClient | null = null;
let dispatchClient: AgentDispatchClient | null = null;

function rooms(): RoomServiceClient {
  roomService ??= new RoomServiceClient(httpUrl(), env.LIVEKIT_API_KEY, env.LIVEKIT_API_SECRET);
  return roomService;
}

function dispatches(): AgentDispatchClient {
  dispatchClient ??= new AgentDispatchClient(httpUrl(), env.LIVEKIT_API_KEY, env.LIVEKIT_API_SECRET);
  return dispatchClient;
}

/** Disconnect everyone from a room. Safe to call if the room no longer exists. */
export async function closeRoom(roomName: string): Promise<void> {
  try {
    await rooms().deleteRoom(roomName);
  } catch (err) {
    logger.warn({ err, roomName }, 'LiveKit: could not delete room');
  }
}

export type MutableSource = 'microphone' | 'camera' | 'screen';

const SOURCE: Record<MutableSource, TrackSource[]> = {
  microphone: [TrackSource.MICROPHONE],
  camera: [TrackSource.CAMERA],
  screen: [TrackSource.SCREEN_SHARE, TrackSource.SCREEN_SHARE_AUDIO],
};

/** Host control: mute someone's mic/camera/screen. They can unmute themselves (like Meet/Zoom). */
export async function muteParticipant(roomName: string, identity: string, source: MutableSource): Promise<number> {
  const p = await rooms().getParticipant(roomName, identity);
  const targets = p.tracks.filter((t) => SOURCE[source].includes(t.source) && !t.muted);
  await Promise.all(targets.map((t) => rooms().mutePublishedTrack(roomName, identity, t.sid, true)));
  return targets.length;
}

export async function removeParticipant(roomName: string, identity: string): Promise<void> {
  await rooms().removeParticipant(roomName, identity);
}

export async function listParticipants(roomName: string) {
  try {
    return await rooms().listParticipants(roomName);
  } catch {
    return []; // room not running
  }
}

/** Bring the AI into a running meeting (if it isn't there already). */
/** Rooms we dispatched the AI to recently – it needs a few seconds to connect. */
const recentDispatch = new Map<string, number>();
const DISPATCH_COOLDOWN_MS = 20_000;

export type DispatchResult = 'dispatched' | 'present' | 'pending' | 'no-room';

/**
 * Bring the AI into a running meeting unless it's already there or on its way. Safe to call
 * repeatedly (never creates a second AI).
 */
export async function ensureAgent(roomName: string, info: AgentDispatchInfo): Promise<DispatchResult> {
  const people = await listParticipants(roomName);
  // Room not running yet: the first join token dispatches the AI when it creates the room.
  if (people.length === 0) return 'no-room';
  if (people.some((p) => p.kind === AGENT_KIND)) return 'present';
  const last = recentDispatch.get(roomName) ?? 0;
  if (Date.now() - last < DISPATCH_COOLDOWN_MS) return 'pending';
  recentDispatch.set(roomName, Date.now());
  await dispatches().createDispatch(roomName, env.AGENT_NAME, { metadata: dispatchMetadata(roomName, info) });
  logger.info({ roomName }, 'AI dispatched into running meeting');
  return 'dispatched';
}

/** Host switched the AI on during the meeting. */
export async function dispatchAgent(roomName: string, info: AgentDispatchInfo): Promise<boolean> {
  return (await ensureAgent(roomName, info)) === 'dispatched';
}

/** Take the AI out of a running meeting. */
export async function removeAgents(roomName: string): Promise<number> {
  const agents = (await listParticipants(roomName)).filter((p) => p.kind === AGENT_KIND);
  await Promise.all(agents.map((a) => rooms().removeParticipant(roomName, a.identity)));
  // Also drop pending dispatches so it doesn't rejoin.
  try {
    const pending = await dispatches().listDispatch(roomName);
    await Promise.all(pending.map((d) => dispatches().deleteDispatch(d.id, roomName)));
  } catch {
    /* nothing pending */
  }
  return agents.length;
}

/**
 * Live room state in room metadata: the agent reads aiProactive, every browser reads recording
 * (to show the REC badge).
 */
export async function setRoomSettings(roomName: string, settings: { aiProactive: boolean; recording?: boolean }): Promise<void> {
  try {
    await rooms().updateRoomMetadata(roomName, JSON.stringify(settings));
  } catch (err) {
    logger.debug({ err, roomName }, 'room not running – settings apply next session');
  }
}
