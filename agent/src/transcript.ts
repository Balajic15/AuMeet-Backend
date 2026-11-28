import { AGENT_DISPLAY_NAME } from './config.js';
import type { Collection, Db } from 'mongodb';
import { log } from '@livekit/agents';

export interface Utterance {
  id: number;
  /** LiveKit identity – `user:<id>`, `guest:<id>`, or the agent's identity. */
  speakerId: string;
  speakerName: string;
  /** Account id for signed-in users, null for guests and the AI. */
  userId: string | null;
  isAgent: boolean;
  /** How it reached the meeting. */
  channel: 'voice' | 'chat';
  text: string;
  language: string;
  at: number;
  /** Voiced time of a spoken line (VAD), for speaking-time analytics. */
  durationMs?: number;
}

/**
 * The running record of who said what. Every speaker has their own speech-to-text
 * stream, so attribution comes from the audio track, not from guessing voices.
 */
export class MeetingTranscript {
  private readonly items: Utterance[] = [];
  private nextId = 1;
  private readonly sink: TranscriptSink | null;

  constructor(
    readonly meetingCode: string,
    readonly sessionId: string,
    sink: TranscriptSink | null = null,
  ) {
    this.sink = sink;
  }

  add(u: Omit<Utterance, 'id'>): Utterance {
    const item = { ...u, id: this.nextId++ };
    this.items.push(item);
    this.sink?.write(this.meetingCode, this.sessionId, item);
    return item;
  }

  get all(): readonly Utterance[] {
    return this.items;
  }

  /** Last `n` lines as `[10:42] Alice: ...` for the model's context. */
  format(n = 60, timeZone?: string): string {
    return formatUtterances(this.items.slice(-n), timeZone);
  }

  /** Distinct human speakers so far, in order of first appearance. */
  speakers(): string[] {
    const seen = new Set<string>();
    for (const u of this.items) if (!u.isAgent) seen.add(u.speakerName);
    return [...seen];
  }
}

export function formatUtterances(items: readonly Utterance[], timeZone?: string): string {
  return items
    .map((u) => {
      const t = new Date(u.at).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', timeZone });
      const via = u.channel === 'chat' ? ' (in chat)' : '';
      return `[${t}] ${u.isAgent ? AGENT_DISPLAY_NAME : u.speakerName}${via}: ${u.text}`;
    })
    .join('\n');
}

/**
 * Optional MongoDB persistence (collection `transcripts`). Writes are fire-and-forget
 * so a slow database never delays the conversation.
 */
export class TranscriptSink {
  private readonly col: Collection;

  constructor(db: Db) {
    this.col = db.collection('transcripts');
    void this.col.createIndex({ meetingCode: 1, at: 1 }).catch(() => {});
  }

  write(meetingCode: string, sessionId: string, u: Utterance): void {
    this.col
      .insertOne({
        meetingCode,
        sessionId,
        seq: u.id,
        speakerId: u.speakerId,
        speakerName: u.speakerName,
        userId: u.userId,
        isAgent: u.isAgent,
        channel: u.channel,
        text: u.text,
        language: u.language,
        at: new Date(u.at),
        ...(u.durationMs ? { durationMs: u.durationMs } : {}),
      })
      .catch((err) => log().warn({ err }, 'failed to store transcript line'));
  }

}
