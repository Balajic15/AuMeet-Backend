import { log, stt, VADEventType, type VAD } from '@livekit/agents';
import { AudioStream, type AudioFrame, type RemoteParticipant, type RemoteTrack } from '@livekit/rtc-node';

export interface ListenerEvents {
  /** Voice activity started (debounced by the VAD's min speech duration) – used for barge-in. */
  onSpeechStart(): void;
  /** Voice activity ended (after the VAD's min silence duration). */
  onSpeechEnd(): void;
  /** A complete utterance from this participant. */
  onUtterance(text: string, language: string): void;
  /** Words so far in the current utterance (for live captions); finals are included. */
  onPartial?(text: string): void;
}

/** If the STT never sends END_OF_SPEECH, flush buffered finals after this much silence. */
const FLUSH_AFTER_MS = 1500;
const SAMPLE_RATE = 16_000;

/**
 * Listens to one participant's microphone: its own speech-to-text stream (so every line is
 * attributed to the right person) plus its own voice-activity detector (so anyone can
 * interrupt the AI the moment they start talking).
 */
export class ParticipantListener {
  private readonly audio: AudioStream;
  private readonly sttStream: stt.SpeechStream;
  private readonly vadStream: ReturnType<VAD['stream']>;
  private closed = false;

  private buffer: string[] = [];
  private bufferLang = '';
  private flushTimer: NodeJS.Timeout | null = null;

  constructor(
    readonly participant: RemoteParticipant,
    track: RemoteTrack,
    sttEngine: stt.STT,
    vad: VAD,
    private readonly events: ListenerEvents,
  ) {
    this.audio = new AudioStream(track, { sampleRate: SAMPLE_RATE, numChannels: 1 });
    this.sttStream = sttEngine.stream();
    this.vadStream = vad.stream();
    void this.pumpAudio();
    void this.readTranscripts();
    void this.readVad();
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.flush();
    this.events.onSpeechEnd();
    void this.audio.cancel().catch(() => {});
    this.sttStream.close();
    this.vadStream.close();
  }

  private async pumpAudio(): Promise<void> {
    const reader = this.audio.getReader();
    try {
      while (!this.closed) {
        const { value, done } = await reader.read();
        if (done) break;
        const frame = value as AudioFrame;
        this.sttStream.pushFrame(frame);
        this.vadStream.pushFrame(frame);
      }
    } catch (err) {
      if (!this.closed) log().warn({ err, who: this.participant.identity }, 'audio stream ended unexpectedly');
    } finally {
      reader.releaseLock();
    }
  }

  private async readTranscripts(): Promise<void> {
    try {
      for await (const ev of this.sttStream) {
        if (this.closed) break;
        const alt = ev.alternatives?.[0];
        if (ev.type === stt.SpeechEventType.FINAL_TRANSCRIPT && alt?.text.trim()) {
          this.buffer.push(alt.text.trim());
          if (alt.language) this.bufferLang = alt.language;
          this.armFlush();
          this.events.onPartial?.(this.buffer.join(' '));
        } else if (ev.type === stt.SpeechEventType.INTERIM_TRANSCRIPT && alt?.text.trim()) {
          this.events.onPartial?.([...this.buffer, alt.text.trim()].join(' '));
        } else if (ev.type === stt.SpeechEventType.END_OF_SPEECH) {
          this.flush();
        }
      }
    } catch (err) {
      if (!this.closed) log().error({ err, who: this.participant.identity }, 'speech-to-text failed');
    }
  }

  private async readVad(): Promise<void> {
    try {
      for await (const ev of this.vadStream) {
        if (this.closed) break;
        if (ev.type === VADEventType.START_OF_SPEECH) this.events.onSpeechStart();
        else if (ev.type === VADEventType.END_OF_SPEECH) this.events.onSpeechEnd();
      }
    } catch (err) {
      if (!this.closed) log().warn({ err }, 'VAD failed');
    }
  }

  private armFlush(): void {
    if (this.flushTimer) clearTimeout(this.flushTimer);
    this.flushTimer = setTimeout(() => this.flush(), FLUSH_AFTER_MS);
  }

  private flush(): void {
    if (this.flushTimer) clearTimeout(this.flushTimer);
    this.flushTimer = null;
    const text = this.buffer.join(' ').replace(/\s+/g, ' ').trim();
    const lang = this.bufferLang;
    this.buffer = [];
    this.bufferLang = '';
    if (text) this.events.onUtterance(text, lang);
  }
}
