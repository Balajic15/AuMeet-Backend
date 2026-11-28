import type { MeetingTranscript, Utterance } from '../transcript.js';
import type { AnalyzeFn } from './gemini.js';
import { COPILOT_SYSTEM, copilotPrompt, type CopilotFn } from './copilot.js';
import { mergeCopilot, normalize, type Person } from './normalize.js';
import { ANALYST_SYSTEM, analystPrompt } from './prompt.js';
import { emptyInsights, type EarlierItemRef, type Insights } from './schema.js';

export interface AnalyzerOptions {
  title: string;
  transcript: MeetingTranscript;
  analyze: AnalyzeFn;
  people: () => Person[];
  onUpdate: (insights: Insights) => void;
  /** The live copilot (its own model call after each notes update); off when absent. */
  copilot?: CopilotFn;
  /** Who is in the room now (for the copilot). */
  present?: () => string[];
  onError?: (err: unknown) => void;
  /** Host's goal/agenda; read on every run so edits during the meeting apply. */
  prep?: () => {
    goal: string;
    agenda: Array<{ id: string; title: string; minutes: number | null }>;
    pastDecisions?: Array<{ ref: string; statement: string; date: string; title: string }>;
    earlierItems?: EarlierItemRef[];
    lessons?: string[];
    copilot?: { enabled: boolean; minRelevance: number; maxSuggestions: number };
    copilotFeedback?: string;
  };
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
  /** Copilot suggestions someone dismissed (key → text), never shown again in this meeting. */
  private readonly dismissed = new Map<string, string>();

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

  /**
   * Make the goal, agenda and follow-ups part of the notes before anything was analysed (and again after
   * the host edits them). Progress already tracked for an agenda item is kept.
   */
  seed(s: {
    carryover: Insights['carryover'];
    goal: string;
    agenda: Array<{ id: string; title: string; minutes: number | null }>;
    now: Date;
  }): void {
    const now = s.now.toISOString();
    const goalText = s.goal.trim();
    const prevGoal = this.state.goal;
    const before = new Map(this.state.agenda.map((a) => [a.id, a]));
    this.state = {
      ...this.state,
      carryover: s.carryover ?? null,
      goal: goalText
        ? prevGoal && prevGoal.text === goalText
          ? prevGoal
          : { text: goalText, status: prevGoal?.status ?? 'on_track', reason: prevGoal?.reason ?? '', since: now }
        : null,
      agenda: s.agenda.map((item) => {
        const old = before.get(item.id);
        return old
          ? { ...old, title: item.title, minutes: item.minutes }
          : { id: item.id, title: item.title, minutes: item.minutes, status: 'not_started' as const, note: '', startedAt: null, doneAt: null };
      }),
    };
  }

  /** Ranked suggestions for the screen; failures just keep the previous view. */
  private async runCopilot(lines: readonly Utterance[], prep: ReturnType<NonNullable<AnalyzerOptions['prep']>> | undefined): Promise<void> {
    const policy = prep?.copilot;
    if (!this.opts.copilot || policy?.enabled === false || this.stopped) return;
    const all = this.opts.transcript.all;
    try {
      const out = await this.opts.copilot(
        COPILOT_SYSTEM,
        copilotPrompt({
          title: this.opts.title,
          insights: this.state,
          lines,
          present: this.opts.present?.() ?? this.opts.transcript.speakers(),
          elapsedMinutes: Math.round((this.now() - all[0]!.at) / 60_000),
          goal: prep?.goal,
          agenda: prep?.agenda,
          pastDecisions: prep?.pastDecisions,
          earlierItems: prep?.earlierItems,
          dismissed: [...this.dismissed.entries()].map(([k, t]) => `${k}: ${t}`),
          feedback: prep?.copilotFeedback,
          now: this.now(),
        }),
      );
      if (this.stopped) return;
      const copilot = mergeCopilot(this.state.copilot ?? null, { copilot: out } as never, new Date(this.now()).toISOString(), {
        ...(policy ?? { enabled: true, minRelevance: 0, maxSuggestions: 5 }),
        dismissed: new Set(this.dismissed.keys()),
      });
      this.state = { ...this.state, copilot };
      this.opts.onUpdate(this.state);
    } catch (err) {
      this.opts.onError?.(err);
    }
  }

  /** Someone dismissed a copilot suggestion: hide it now and never show it again in this meeting. */
  dismissSuggestion(key: string): Insights | null {
    const c = this.state.copilot;
    const hit = c?.suggestions?.find((x) => x.key === key);
    this.dismissed.set(key, hit?.text ?? key);
    if (!c || !hit) return null;
    const suggestions = (c.suggestions ?? []).filter((x) => x.key !== key);
    this.state = { ...this.state, copilot: { ...c, suggestions } };
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
          pastDecisions: prep?.pastDecisions,
          earlierItems: prep?.earlierItems,
          lessons: prep?.lessons,
          elapsedMinutes: Math.round((this.now() - all[0]!.at) / 60_000),
        }),
      );
      this.state = normalize(this.state, out, {
        validLines: new Set(all.map((u) => u.id)),
        lineInfo: new Map(all.map((u) => [u.id, { at: u.at, speaker: u.speakerName }])),
        people: this.opts.people(),
        analyzedThrough: through,
        now: new Date(this.now()),
        goal: prep?.goal,
        agendaPlan: prep?.agenda,
        pastDecisions: prep?.pastDecisions,
        earlierItems: prep?.earlierItems,
        copilot: prep?.copilot ? { ...prep.copilot, dismissed: new Set(this.dismissed.keys()) } : undefined,
      });
      this.pending = Math.max(0, this.pending - consumed);
      this.opts.onUpdate(this.state);
      if (!final) await this.runCopilot(lines, prep);
    } catch (err) {
      // Keep the previous notes; the next batch retries with the lines still pending.
      this.opts.onError?.(err);
    }
  }
}
