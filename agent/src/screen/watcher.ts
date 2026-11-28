import { log } from '@livekit/agents';
import { VideoBufferType, VideoStream, type RemoteTrack, type VideoFrameEvent } from '@livekit/rtc-node';
import { changeScore, thumbnail, type Rgba } from './image.js';

/*
 * Watches one shared screen without processing every frame: one sample per `sampleMs`, compared on a 64×36 grey
 * thumbnail. A change is reported only once the picture has SETTLED (two samples in a row look alike – not while
 * scrolling or a page is loading) and differs enough from the last frame that was analysed.
 */

export interface WatcherOptions {
  sampleMs: number;
  /** 0–1 share of thumbnail pixels that must differ from the last analysed frame. */
  changeThreshold: () => number;
  /** Called with a settled, changed frame; return true if it was analysed (it becomes the new reference). */
  onChange: (img: Rgba, score: number) => Promise<boolean>;
  now?: () => number;
}

/** Below this, two consecutive samples count as "the same picture" (settled). */
const SETTLED = 0.02;

export class ScreenWatcher {
  private readonly stream: VideoStream;
  private closed = false;
  private lastSampleAt = 0;
  private prevThumb: Uint8Array | null = null;
  private analysedThumb: Uint8Array | null = null;
  private busy = false;
  /** The newest sampled frame (for "look at this" and screenshots). */
  latest: Rgba | null = null;
  latestAt = 0;

  constructor(track: RemoteTrack, private readonly o: WatcherOptions) {
    this.stream = new VideoStream(track);
    void this.pump();
  }

  close(): void {
    this.closed = true;
    void this.stream.cancel().catch(() => {});
  }

  /** Mark the current picture as analysed (after an on-demand look). */
  markAnalysed(): void {
    if (this.latest) this.analysedThumb = thumbnail(this.latest);
  }

  private async pump(): Promise<void> {
    const reader = this.stream.getReader();
    const now = this.o.now ?? Date.now;
    try {
      while (!this.closed) {
        const { value, done } = await reader.read();
        if (done) break;
        const t = now();
        if (t - this.lastSampleAt < this.o.sampleMs) continue; // drop frames between samples
        this.lastSampleAt = t;
        this.sample((value as VideoFrameEvent).frame.convert(VideoBufferType.RGBA), t);
      }
    } catch (err) {
      if (!this.closed) log().warn({ err }, 'screen stream ended unexpectedly');
    } finally {
      reader.releaseLock();
    }
  }

  private sample(frame: { data: Uint8Array; width: number; height: number }, t: number): void {
    const img: Rgba = { data: new Uint8Array(frame.data), width: frame.width, height: frame.height };
    this.latest = img;
    this.latestAt = t;
    const thumb = thumbnail(img);
    const settled = !!this.prevThumb && changeScore(thumb, this.prevThumb) < SETTLED;
    this.prevThumb = thumb;
    if (!settled || this.busy) return;
    const score = this.analysedThumb ? changeScore(thumb, this.analysedThumb) : 1;
    if (score < this.o.changeThreshold()) return;
    this.busy = true;
    void this.o
      .onChange(img, score)
      .then((analysed) => {
        if (analysed) this.analysedThumb = thumb;
      })
      .catch(() => {})
      .finally(() => {
        this.busy = false;
      });
  }
}
