import { Injectable, OnDestroy, computed, signal } from '@angular/core';
import {
  ConnectionState,
  DisconnectReason,
  Participant,
  RemoteTrack,
  Room,
  RoomEvent,
  Track,
  type LocalTrack,
  type VideoTrack,
} from 'livekit-client';
import type { ParticipantRole } from '../core/meetings.service';
import type { Insights } from '../core/insights';

export const CHAT_TOPIC = 'lk.chat'; // same topic LiveKit Agents listens on, so the AI can read chat too
export const INSIGHTS_TOPIC = 'aumeet.insights'; // live notes from the AI agent
export const CAPTIONS_TOPIC = 'aumeet.captions'; // what people say, transcribed by the agent
export const AGENT_SPEECH_TOPIC = 'lk.transcription'; // what the AI itself says
export const REACTION_TOPIC = 'aumeet.reaction';

/** Participant attributes (set by each person for themselves). */
export const HAND_ATTR = 'aumeet.hand';
export const TRANSCRIBE_ATTR = 'aumeet.transcribe';
/** '1' = several people speak through this device (the AI separates their voices). */
export const SHARED_ATTR = 'aumeet.shared';

export const REACTIONS = ['👍', '👏', '😂', '🎉', '❤️', '🤔'] as const;

export interface ParticipantView {
  identity: string;
  name: string;
  isLocal: boolean;
  isAgent: boolean;
  role: ParticipantRole | 'agent';
  isSpeaking: boolean;
  micOn: boolean;
  camOn: boolean;
  handRaised: boolean;
  /** False when the person opted out of AI transcription. */
  transcribed: boolean;
  sharedDevice: boolean;
  camera?: VideoTrack;
  screen?: VideoTrack;
}

export interface ChatMessage {
  id: string;
  from: string;
  fromName: string;
  isLocal: boolean;
  text: string;
  at: number;
}

export interface CaptionLine {
  id: string;
  name: string;
  text: string;
  final: boolean;
  at: number;
}

export interface FloatingReaction {
  id: number;
  emoji: string;
  name: string;
  /** 0–1 horizontal position so simultaneous reactions don't overlap. */
  x: number;
}

export interface DevicePrefs {
  audioinput?: string;
  videoinput?: string;
  audiooutput?: string;
}

export type EndReason = 'left' | 'ended' | 'removed' | 'lost';

const DEVICE_KEY = 'aumeet_device_ids';
const CAPTION_TTL_MS = 6000;
const MAX_CAPTIONS = 3;

export function readDevicePrefs(): DevicePrefs {
  try {
    return JSON.parse(localStorage.getItem(DEVICE_KEY) ?? '{}') as DevicePrefs;
  } catch {
    return {};
  }
}

export function saveDevicePrefs(p: DevicePrefs): void {
  try {
    localStorage.setItem(DEVICE_KEY, JSON.stringify(p));
  } catch {
    /* ignore */
  }
}

/**
 * Role from the identity, which the join token fixes. Participants can edit their own metadata, so a
 * "role" claimed there is never trusted. The host is `user:<hostId>`; guests are `guest:<id>`.
 */
function roleOf(p: Participant, hostIdentity: string | null): ParticipantView['role'] {
  if (p.isAgent) return 'agent';
  if (hostIdentity && p.identity === hostIdentity) return 'host';
  if (p.identity.startsWith('guest:')) return 'guest';
  return 'participant';
}

function toView(p: Participant, isLocal: boolean, hostIdentity: string | null): ParticipantView {
  const cam = p.getTrackPublication(Track.Source.Camera);
  const screen = p.getTrackPublication(Track.Source.ScreenShare);
  return {
    identity: p.identity,
    name: p.name || p.identity,
    isLocal,
    isAgent: p.isAgent,
    role: roleOf(p, hostIdentity),
    isSpeaking: p.isSpeaking,
    micOn: p.isMicrophoneEnabled,
    camOn: !!cam?.track && !cam.isMuted,
    handRaised: p.attributes?.[HAND_ATTR] === '1',
    transcribed: p.attributes?.[TRANSCRIBE_ATTR] !== 'off',
    sharedDevice: p.attributes?.[SHARED_ATTR] === '1',
    camera: cam?.track && !cam.isMuted ? (cam.track as VideoTrack) : undefined,
    screen: screen?.track && !screen.isMuted ? (screen.track as VideoTrack) : undefined,
  };
}

/**
 * One instance per meeting page. Wraps a LiveKit Room and exposes its state as signals.
 */
@Injectable()
export class RoomService implements OnDestroy {
  readonly room = new Room({ adaptiveStream: true, dynacast: true });

  readonly participants = signal<ParticipantView[]>([]);
  readonly connection = signal<ConnectionState>(ConnectionState.Disconnected);
  readonly messages = signal<ChatMessage[]>([]);
  readonly unread = signal(0);
  readonly audioBlocked = signal(false);
  readonly endReason = signal<EndReason | null>(null);
  /** Latest AI meeting notes (decisions, tasks, questions), pushed by the agent. */
  readonly insights = signal<Insights | null>(null);
  readonly captions = signal<CaptionLine[]>([]);
  readonly reactions = signal<FloatingReaction[]>([]);
  /** Set when the host muted this user's microphone remotely (for a one-off notice). */
  readonly mutedByHost = signal(0);
  readonly hasAgent = computed(() => this.participants().some((p) => p.isAgent));
  /** The AI's name as it appears in the room (from its behaviour settings, e.g. "Maaya"). */
  readonly agentName = computed(() => this.participants().find((p) => p.isAgent)?.name ?? 'The AI');
  /** The host is recording this meeting (room metadata, visible to everyone). */
  readonly recording = signal(false);

  readonly local = computed(() => this.participants().find((p) => p.isLocal));
  readonly micOn = computed(() => this.local()?.micOn ?? false);
  readonly camOn = computed(() => this.local()?.camOn ?? false);
  readonly screenOn = computed(() => !!this.local()?.screen);
  readonly handRaised = computed(() => !!this.local()?.handRaised);
  readonly transcribed = computed(() => this.local()?.transcribed ?? true);
  readonly sharedDevice = computed(() => !!this.local()?.sharedDevice);
  /** The first active screen share (shown on the big stage). */
  readonly screenShare = computed(() => this.participants().find((p) => p.screen));

  private chatOpen = false;
  private audioHost: HTMLElement | null = null;
  private leaving = false;
  private lastMicToggle = 0;
  private reactionId = 0;
  private captionTimer: ReturnType<typeof setInterval> | null = null;

  constructor() {
    const r = this.room;
    const refresh = () => this.refresh();
    r.on(RoomEvent.ParticipantConnected, refresh)
      .on(RoomEvent.ParticipantDisconnected, refresh)
      .on(RoomEvent.ParticipantNameChanged, refresh)
      .on(RoomEvent.ParticipantMetadataChanged, refresh)
      .on(RoomEvent.ParticipantAttributesChanged, refresh)
      .on(RoomEvent.TrackSubscribed, (t) => {
        this.attachAudio(t);
        refresh();
      })
      .on(RoomEvent.TrackUnsubscribed, (t) => {
        t.detach().forEach((el) => el.remove());
        refresh();
      })
      .on(RoomEvent.TrackMuted, (pub, p) => {
        // The local mic got muted without us asking → the host did it.
        if (p.isLocal && pub.source === Track.Source.Microphone && Date.now() - this.lastMicToggle > 1500) {
          this.mutedByHost.update((n) => n + 1);
        }
        refresh();
      })
      .on(RoomEvent.TrackUnmuted, refresh)
      .on(RoomEvent.LocalTrackPublished, refresh)
      .on(RoomEvent.LocalTrackUnpublished, refresh)
      .on(RoomEvent.ActiveSpeakersChanged, refresh)
      .on(RoomEvent.ConnectionStateChanged, (s) => this.connection.set(s))
      .on(RoomEvent.AudioPlaybackStatusChanged, () => this.audioBlocked.set(!r.canPlaybackAudio))
      .on(RoomEvent.DataReceived, (payload, participant, _kind, topic) => {
        if (topic !== REACTION_TOPIC || !participant) return;
        try {
          const { emoji } = JSON.parse(new TextDecoder().decode(payload)) as { emoji?: string };
          if (emoji && (REACTIONS as readonly string[]).includes(emoji)) this.showReaction(emoji, participant.name || participant.identity);
        } catch {
          /* ignore */
        }
      })
      .on(RoomEvent.RoomMetadataChanged, (m) => this.readRoomState(m))
      .on(RoomEvent.Disconnected, (reason) => this.onDisconnected(reason));

    // What the AI says, streamed word by word.
    r.registerTextStreamHandler(AGENT_SPEECH_TOPIC, async (reader, from) => {
      const p = r.getParticipantByIdentity(from.identity);
      if (!p?.isAgent) {
        await reader.readAll();
        return;
      }
      const id = `agent:${reader.info.attributes?.['lk.segment_id'] ?? reader.info.id}`;
      let text = '';
      for await (const chunk of reader) {
        text += chunk;
        this.upsertCaption({ id, name: p.name || 'AI', text, final: false, at: Date.now() });
      }
      this.upsertCaption({ id, name: p.name || 'AI', text, final: true, at: Date.now() });
    });

    // What people say, transcribed by the agent (only trusted from the agent).
    r.registerTextStreamHandler(CAPTIONS_TOPIC, async (reader, from) => {
      const raw = await reader.readAll();
      if (!r.getParticipantByIdentity(from.identity)?.isAgent) return;
      try {
        const c = JSON.parse(raw) as { id: string; name: string; text: string; final: boolean };
        if (c.id && c.text) this.upsertCaption({ id: c.id, name: c.name, text: c.text, final: !!c.final, at: Date.now() });
      } catch {
        /* ignore */
      }
    });

    r.registerTextStreamHandler(INSIGHTS_TOPIC, async (reader, from) => {
      const raw = await reader.readAll();
      // Only trust notes published by the AI agent.
      if (!r.getParticipantByIdentity(from.identity)?.isAgent) return;
      try {
        const msg = JSON.parse(raw) as { type?: string; insights?: Insights };
        if (msg.type === 'insights' && msg.insights) this.insights.set(msg.insights);
      } catch {
        /* ignore malformed payloads */
      }
    });

    r.registerTextStreamHandler(CHAT_TOPIC, async (reader, from) => {
      const text = await reader.readAll();
      const p = r.getParticipantByIdentity(from.identity);
      this.pushMessage({
        id: reader.info.id,
        from: from.identity,
        fromName: p?.name || from.identity,
        isLocal: false,
        text,
        at: reader.info.timestamp || Date.now(),
      });
    });

    // Expire old captions.
    this.captionTimer = setInterval(() => {
      const now = Date.now();
      const keep = this.captions().filter((c) => !c.final || now - c.at < CAPTION_TTL_MS);
      if (keep.length !== this.captions().length) this.captions.set(keep);
    }, 1000);
  }

  /** Remote audio plays through hidden <audio> elements inside this host element. */
  setAudioHost(el: HTMLElement): void {
    this.audioHost = el;
  }

  /** `user:<hostId>` of this meeting (from the server), used to show who the host is. */
  private hostIdentity: string | null = null;

  async connect(url: string, token: string, opts: { mic: boolean; cam: boolean; shared?: boolean; hostId?: string }): Promise<void> {
    this.hostIdentity = opts.hostId ? `user:${opts.hostId}` : null;
    this.endReason.set(null);
    this.leaving = false;
    await this.room.connect(url, token);
    this.readRoomState(this.room.metadata);
    this.refresh();
    // Attach audio for anyone already in the room.
    for (const p of this.room.remoteParticipants.values()) {
      for (const pub of p.audioTrackPublications.values()) if (pub.track) this.attachAudio(pub.track);
    }
    this.audioBlocked.set(!this.room.canPlaybackAudio);
    const prefs = readDevicePrefs();
    // Device errors shouldn't kick the user out of the meeting.
    await Promise.allSettled([
      opts.mic ? this.room.localParticipant.setMicrophoneEnabled(true, prefs.audioinput ? { deviceId: prefs.audioinput } : undefined) : null,
      opts.cam ? this.room.localParticipant.setCameraEnabled(true, prefs.videoinput ? { deviceId: prefs.videoinput } : undefined) : null,
      prefs.audiooutput ? this.room.switchActiveDevice('audiooutput', prefs.audiooutput) : null,
      opts.shared ? this.room.localParticipant.setAttributes({ [SHARED_ATTR]: '1' }) : null,
    ]);
    this.refresh();
  }

  async toggleMic(): Promise<void> {
    this.lastMicToggle = Date.now();
    await this.room.localParticipant.setMicrophoneEnabled(!this.micOn());
    this.refresh();
  }

  async toggleCam(): Promise<void> {
    await this.room.localParticipant.setCameraEnabled(!this.camOn());
    this.refresh();
  }

  /** Throws if the user cancels the browser's share picker – callers can ignore that. */
  async toggleScreen(): Promise<void> {
    await this.room.localParticipant.setScreenShareEnabled(!this.screenOn(), { audio: true });
    this.refresh();
  }

  async toggleHand(): Promise<void> {
    await this.room.localParticipant.setAttributes({ [HAND_ATTR]: this.handRaised() ? '' : '1' });
    this.refresh();
  }

  /** Privacy: stop (or resume) AI transcription of my voice and chat. */
  async setTranscribed(on: boolean): Promise<void> {
    await this.room.localParticipant.setAttributes({ [TRANSCRIBE_ATTR]: on ? 'on' : 'off' });
    this.refresh();
  }

  /** Conference-room mode: several people talk through this device. */
  async setSharedDevice(on: boolean): Promise<void> {
    await this.room.localParticipant.setAttributes({ [SHARED_ATTR]: on ? '1' : '' });
    this.refresh();
  }

  async react(emoji: (typeof REACTIONS)[number]): Promise<void> {
    this.showReaction(emoji, 'You');
    await this.room.localParticipant.publishData(new TextEncoder().encode(JSON.stringify({ emoji })), {
      reliable: false,
      topic: REACTION_TOPIC,
    });
  }

  async startAudio(): Promise<void> {
    await this.room.startAudio();
    this.audioBlocked.set(!this.room.canPlaybackAudio);
  }

  // ----- devices -----

  async listDevices(kind: MediaDeviceKind): Promise<MediaDeviceInfo[]> {
    try {
      return await Room.getLocalDevices(kind, false);
    } catch {
      return [];
    }
  }

  activeDevice(kind: MediaDeviceKind): string | undefined {
    return this.room.getActiveDevice(kind) ?? readDevicePrefs()[kind as keyof DevicePrefs];
  }

  async switchDevice(kind: MediaDeviceKind, deviceId: string): Promise<void> {
    saveDevicePrefs({ ...readDevicePrefs(), [kind]: deviceId });
    if (this.room.state === ConnectionState.Connected) await this.room.switchActiveDevice(kind, deviceId);
  }

  // ----- chat -----

  async sendChat(text: string): Promise<void> {
    const t = text.trim();
    if (!t) return;
    const info = await this.room.localParticipant.sendText(t, { topic: CHAT_TOPIC });
    const me = this.room.localParticipant;
    this.pushMessage({ id: info.id, from: me.identity, fromName: me.name || 'You', isLocal: true, text: t, at: Date.now() });
  }

  setChatOpen(open: boolean): void {
    this.chatOpen = open;
    if (open) this.unread.set(0);
  }

  async leave(): Promise<void> {
    this.leaving = true;
    await this.room.disconnect();
  }

  ngOnDestroy(): void {
    this.leaving = true;
    if (this.captionTimer) clearInterval(this.captionTimer);
    void this.room.disconnect();
    this.room.removeAllListeners();
  }

  private readRoomState(raw: string | undefined): void {
    try {
      this.recording.set(!!(JSON.parse(raw || '{}') as { recording?: boolean }).recording);
    } catch {
      this.recording.set(false);
    }
  }

  private upsertCaption(c: CaptionLine): void {
    const list = this.captions().filter((x) => x.id !== c.id);
    list.push(c);
    this.captions.set(list.slice(-MAX_CAPTIONS));
  }

  private showReaction(emoji: string, name: string): void {
    const id = ++this.reactionId;
    this.reactions.update((r) => [...r, { id, emoji, name, x: 0.1 + Math.random() * 0.8 }]);
    setTimeout(() => this.reactions.update((r) => r.filter((x) => x.id !== id)), 4000);
  }

  private pushMessage(m: ChatMessage): void {
    this.messages.update((list) => (list.some((x) => x.id === m.id) ? list : [...list, m]));
    if (!this.chatOpen && !m.isLocal) this.unread.update((n) => n + 1);
  }

  private attachAudio(track: RemoteTrack | LocalTrack): void {
    if (track.kind !== Track.Kind.Audio || !this.audioHost) return;
    const el = track.attach();
    el.dataset['lk'] = 'audio';
    this.audioHost.appendChild(el);
  }

  private refresh(): void {
    const r = this.room;
    if (r.state === ConnectionState.Disconnected) return;
    const remotes = [...r.remoteParticipants.values()].map((p) => toView(p, false, this.hostIdentity));
    // AI agent first, then raised hands, then others in join order; me last.
    remotes.sort((a, b) => Number(b.isAgent) - Number(a.isAgent) || Number(b.handRaised) - Number(a.handRaised));
    this.participants.set([...remotes, toView(r.localParticipant, true, this.hostIdentity)]);
  }

  private onDisconnected(reason?: DisconnectReason): void {
    this.audioHost?.querySelectorAll('[data-lk="audio"]').forEach((el) => el.remove());
    this.participants.set([]);
    this.captions.set([]);
    if (this.leaving || reason === DisconnectReason.CLIENT_INITIATED) this.endReason.set('left');
    else if (reason === DisconnectReason.ROOM_DELETED) this.endReason.set('ended');
    else if (reason === DisconnectReason.PARTICIPANT_REMOVED) this.endReason.set('removed');
    else this.endReason.set('lost');
  }
}
