import type { MeetingTranscript } from '../transcript.js';
import type { AnalyzeFn } from './gemini.js';
import { normalize, type Person } from './normalize.js';
import { ANALYST_SYSTEM, analystPrompt } from './prompt.js';
import { emptyInsights, type Insights } from './schema.js';

export interface AnalyzerOptions {
  title: string;
  transcript: MeetingTranscript;
  analyze: AnalyzeFn;
  people: () => Person[];
  onUpdate: (insights: Insights) => void;
  onError?: (err: unknown) => void;
  /** Host's goal/agenda; read on every run so edits during the meeting apply. */
  prep?: () => { goal: string; agenda: Array<{ id: string; title: string; minutes: number | null }> };
  /** Run once this many new human lines have arrived. */
  batchSize?: number;
  /** …or after this much quiet with at least one new line. */
  idleMs?: number;
  /** Never run more often than this. */
  minIntervalMs?: number;
  /** How many transcript lines the model sees per run. */
  windowLines?: number;
  now?: () => number;
}

/**
 * Keeps structured notes (decisions, tasks, questions, topics) up to date while the meeting
 * runs. One analysis at a time; new lines that arrive meanwhile trigger a follow-up run.
 */
export class MeetingAnalyzer {
  private state: Insights = emptyInsights();
  private pending = 0;
  private running: Promise<void> | null = null;
  private rerun = false;
  private lastRunAt = 0;
  private timer: NodeJS.Timeout | null = null;
  private stopped = false;

  private readonly batchSize: number;
  private readonly idleMs: number;
  private readonly minIntervalMs: number;
  private readonly windowLines: number;
  private readonly now: () => number;

  constructor(private readonly opts: AnalyzerOptions) {
    this.batchSize = opts.batchSize ?? 4;
    this.idleMs = opts.idleMs ?? 12_000;
    this.minIntervalMs = opts.minIntervalMs ?? 15_000;
    this.windowLines = opts.windowLines ?? 200;
    this.now = opts.now ?? Date.now;
  }

  get insights(): Insights {
    return this.state;
  }

  /** Call after every new human utterance (voice or chat). */
  notify(): void {
    if (this.stopped) return;
    this.pending++;
    this.clearTimer();
    if (this.pending >= this.batchSize) {
      this.schedule(Math.max(0, this.lastRunAt + this.minIntervalMs - this.now()));
    } else {
      this.schedule(Math.max(this.idleMs, this.lastRunAt + this.minIntervalMs - this.now()));
    }
  }

  /** Final pass when the meeting ends. Resolves with the final notes. */
  async finish(): Promise<Insights> {
    this.stopped = true;
    this.clearTimer();
    if (this.running) await this.running;
    // Always do a final pass when anything was said, so the summary covers the whole meeting.
    if (this.opts.transcript.all.some((u) => !u.isAgent)) await this.analyze(true);
    return this.state;
  }

  private schedule(delay: number): void {
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.run();
    }, delay);
  }

  private clearTimer(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  private async run(): Promise<void> {
    if (this.running) {
      this.rerun = true;
      return;
    }
    if (this.pending === 0) return;
    this.running = this.analyze(false).finally(() => {
      this.running = null;
      if (this.rerun && !this.stopped) {
        this.rerun = false;
        this.schedule(this.minIntervalMs);
      }
    });
    await this.running;
  }

  private async analyze(final: boolean): Promise<void> {
    const all = this.opts.transcript.all;
    if (all.length === 0) return;
    const lines = all.slice(-this.windowLines);
    const through = all[all.length - 1]!.id;
    const consumed = this.pending;
    this.lastRunAt = this.now();
    const prep = this.opts.prep?.();

    try {
      const out = await this.opts.analyze(
        ANALYST_SYSTEM,
        analystPrompt({
          title: this.opts.title,
          meetingDate: new Date(all[0]!.at),
          participants: this.opts.transcript.speakers(),
          current: this.state,
          lines,
          final,
          goal: prep?.goal,
          agenda: prep?.agenda,
          elapsedMinutes: Math.round((this.now() - all[0]!.at) / 60_000),
        }),
      );
      this.state = normalize(this.state, out, {
        validLines: new Set(all.map((u) => u.id)),
        people: this.opts.people(),
        analyzedThrough: through,
        now: new Date(this.now()),
        goal: prep?.goal,
        agendaPlan: prep?.agenda,
      });
      this.pending = Math.max(0, this.pending - consumed);
      this.opts.onUpdate(this.state);
    } catch (err) {
      // Keep the previous notes; the next batch retries with the lines still pending.
      this.opts.onError?.(err);
    }
  }
}
