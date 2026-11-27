import type { Insights } from '../intel/schema.js';
import type { Utterance } from '../transcript.js';
import { DEFAULT_TIMING, findCandidates, type Candidate, type CandidateTiming } from './candidates.js';
import type { JudgeFn, Verdict } from './judge.js';

export interface InterventionOptions {
  judge: JudgeFn;
  /** Say something out loud (the session's TTS). */
  speak: (message: string, candidate: Candidate) => void;
  insights: () => Insights;
  transcript: () => readonly Utterance[];
  /** False while the AI is already speaking or preparing a reply. */
  agentIdle: () => boolean;
  /** Host setting: may the AI speak up on its own at all? */
  enabled: boolean;
  /** Host setting: facilitator mode (opening, agenda transitions, wrap-up). Read on every check. */
  facilitator?: () => boolean;
  /** Silence needed before interjecting. */
  pauseMs?: number;
  /** Minimum gap after the AI last spoke (for any reason). */
  cooldownMs?: number;
  /** No interjections this soon after the AI joins. */
  warmupMs?: number;
  /** How many judge calls one issue may get (e.g. "not now" → try once more later). */
  maxAttemptsPerIssue?: number;
  retryAfterMs?: number;
  timing?: CandidateTiming;
  recentLines?: number;
  now?: () => number;
  log?: (msg: string, data?: Record<string, unknown>) => void;
}

/**
 * Decides when the AI speaks without being asked. Silence is the default:
 * a rule-based candidate must exist, the room must be in a natural pause, cooldowns must
 * have passed, and the model must agree that now is a good moment.
 */
export class InterventionController {
  private readonly speaking = new Set<string>();
  private readonly raised = new Set<string>();
  private readonly attempts = new Map<string, { count: number; lastAt: number }>();
  private readonly startedAt: number;
  private lastHumanSpeechAt: number;
  private lastAgentSpokeAt: number | null = null;
  /** Bumped whenever someone starts talking – invalidates an in-flight judgement. */
  private epoch = 0;
  private checking = false;
  private timer: NodeJS.Timeout | null = null;
  private quiet = false;
  private stopped = false;
  private enabled: boolean;

  private readonly pauseMs: number;
  private readonly cooldownMs: number;
  private readonly warmupMs: number;
  private readonly maxAttempts: number;
  private readonly retryAfterMs: number;
  private readonly recentLines: number;
  private readonly now: () => number;

  constructor(private readonly o: InterventionOptions) {
    this.pauseMs = o.pauseMs ?? 1800;
    this.cooldownMs = o.cooldownMs ?? 90_000;
    this.warmupMs = o.warmupMs ?? 30_000;
    this.maxAttempts = o.maxAttemptsPerIssue ?? 2;
    this.retryAfterMs = o.retryAfterMs ?? 30_000;
    this.recentLines = o.recentLines ?? 30;
    this.now = o.now ?? Date.now;
    this.enabled = o.enabled;
    this.startedAt = this.now();
    this.lastHumanSpeechAt = this.startedAt;
  }

  get isQuiet(): boolean {
    return this.quiet;
  }

  /** Host setting changed during the meeting (room metadata). */
  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
    if (!enabled) this.clearTimer();
  }

  get isEnabled(): boolean {
    return this.enabled;
  }

  /** "AuMeet, stay quiet" / "you can speak up again". */
  setQuiet(quiet: boolean): void {
    this.quiet = quiet;
    if (quiet) this.clearTimer();
  }

  humanSpeechStarted(identity: string): void {
    this.speaking.add(identity);
    this.lastHumanSpeechAt = this.now();
    this.epoch++;
    this.clearTimer();
  }

  humanSpeechEnded(identity: string): void {
    this.speaking.delete(identity);
    this.lastHumanSpeechAt = this.now();
    if (this.speaking.size === 0) this.schedule(this.pauseMs);
  }

  participantLeft(identity: string): void {
    if (this.speaking.delete(identity) && this.speaking.size === 0) this.schedule(this.pauseMs);
  }

  /** Call whenever the AI finishes saying anything (answers count too). */
  agentFinishedSpeaking(): void {
    this.lastAgentSpokeAt = this.now();
  }

  /** Time-based prompts (opening, over time, wrap-up) must fire in silence too: call every few seconds. */
  tick(): void {
    if (this.timer || this.checking) return;
    this.notesUpdated();
  }

  /** Mark an issue as handled without speaking (e.g. the opening was replaced by something else). */
  markRaised(key: string): void {
    this.raised.add(key);
  }

  /** New notes may contain new candidates – check if we're already in a pause. */
  notesUpdated(): void {
    if (this.speaking.size > 0) return;
    const silent = this.now() - this.lastHumanSpeechAt;
    this.schedule(Math.max(0, this.pauseMs - silent));
  }

  stop(): void {
    this.stopped = true;
    this.clearTimer();
  }

  private schedule(ms: number): void {
    if (this.stopped || !this.enabled || this.quiet) return;
    this.clearTimer();
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.check();
    }, ms);
  }

  private clearTimer(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  /** Exposed for tests. */
  async check(): Promise<Verdict | null> {
    if (this.stopped || !this.enabled || this.quiet || this.checking) return null;
    if (this.speaking.size > 0) return null;

    const now = this.now();
    const silence = now - this.lastHumanSpeechAt;
    if (silence < this.pauseMs) return null;
    if (now - this.startedAt < this.warmupMs) return null;
    if (!this.o.agentIdle()) return null;

    const sinceAgent = this.lastAgentSpokeAt === null ? Infinity : now - this.lastAgentSpokeAt;
    const candidate = findCandidates(this.o.insights(), this.o.transcript(), now, this.raised, this.o.timing ?? DEFAULT_TIMING, {
      facilitator: this.o.facilitator?.() ?? false,
    }).find((c) => {
      if (sinceAgent < (c.minGapMs ?? this.cooldownMs)) return false;
      const a = this.attempts.get(c.key);
      return !a || (a.count < (c.maxAttempts ?? this.maxAttempts) && now - a.lastAt >= this.retryAfterMs);
    });
    if (!candidate) return null;

    const a = this.attempts.get(candidate.key) ?? { count: 0, lastAt: 0 };
    this.attempts.set(candidate.key, { count: a.count + 1, lastAt: now });

    const epochAtStart = this.epoch;
    this.checking = true;
    let verdict: Verdict;
    try {
      verdict = await this.o.judge({
        candidate,
        insights: this.o.insights(),
        recent: this.o.transcript().slice(-this.recentLines),
        silenceMs: silence,
      });
    } catch (err) {
      this.o.log?.('intervention judge failed', { err: String(err), key: candidate.key });
      return null;
    } finally {
      this.checking = false;
    }

    const message = verdict.message.trim();
    this.o.log?.('intervention verdict', { key: candidate.key, speak: verdict.speak, reason: verdict.reason });
    if (!verdict.speak || !message) return verdict;

    // Someone started talking while we were thinking, or the AI got busy – the moment has passed.
    if (this.epoch !== epochAtStart || this.speaking.size > 0 || this.quiet || this.stopped || !this.o.agentIdle()) {
      return { ...verdict, speak: false, reason: 'moment passed' };
    }

    this.raised.add(candidate.key);
    this.lastAgentSpokeAt = this.now();
    this.o.speak(message, candidate);
    return verdict;
  }
}
