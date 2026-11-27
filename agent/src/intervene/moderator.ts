import type { Behaviour } from '../behaviour.js';
import type { BrainDecision, BrainEvent, BrainFn, Remark } from '../brain.js';
import type { Insights } from '../intel/schema.js';
import type { IntentStats } from '../learning.js';
import type { Utterance } from '../transcript.js';

export interface ModeratorOptions {
  brain: BrainFn;
  /** Say something out loud. */
  speak: (message: string, decision: BrainDecision) => void;
  behaviour: () => Behaviour | null;
  insights: () => Insights;
  transcript: () => readonly Utterance[];
  present: () => string[];
  /** False while the AI is already speaking or preparing a reply. */
  agentIdle: () => boolean;
  facilitator: () => boolean;
  prep: () => string;
  learning: () => IntentStats[];
  /** Host setting: may the AI speak up on its own at all? */
  enabled: boolean;
  title: string;
  /** A remark's reaction was judged (engaged / ignored / rejected). */
  onReaction?: (remark: Remark) => void;
  now?: () => number;
  log?: (msg: string, data?: Record<string, unknown>) => void;
}

/**
 * Runs the meeting brain at natural pauses and when it asked to look again. The model decides what
 * (and whether) to say; this class only enforces the host's limits from the behaviour settings and
 * the one hard rule: never talk over people.
 */
export class Moderator {
  private readonly speaking = new Set<string>();
  private readonly remarks: Remark[] = [];
  private readonly joinedAt: number;
  private lastHumanSpeechAt: number;
  private lastAgentSpokeAt: number | null = null;
  private lastCheckAt = 0;
  private nextCheckAt = Infinity;
  private newLines = 0;
  private epoch = 0;
  private checking = false;
  private timer: NodeJS.Timeout | null = null;
  private startPending = false;
  private quiet = false;
  private stopped = false;
  private enabled: boolean;
  private seq = 0;
  private readonly now: () => number;

  constructor(private readonly o: ModeratorOptions) {
    this.now = o.now ?? Date.now;
    this.enabled = o.enabled;
    this.joinedAt = this.now();
    this.lastHumanSpeechAt = this.joinedAt;
  }

  get isQuiet(): boolean {
    return this.quiet;
  }
  get isEnabled(): boolean {
    return this.enabled;
  }
  get recentRemarks(): readonly Remark[] {
    return this.remarks;
  }

  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
    if (!enabled) this.clearTimer();
  }

  /** "Stay quiet" / "you can speak up again" – the voice assistant calls this through a tool. */
  setQuiet(quiet: boolean): void {
    this.quiet = quiet;
    if (quiet) {
      this.clearTimer();
      // Being told to be quiet is the clearest reaction to whatever it just raised.
      for (const r of this.remarks) if (r.reaction === 'pending') this.settle(r, 'rejected');
    }
  }

  /** People are in the room: let the brain decide how (and whether) to introduce itself. */
  start(): void {
    if (this.startPending || this.lastCheckAt > 0) return;
    this.startPending = true;
    this.scheduleAfterPause();
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
    if (this.speaking.size === 0) this.scheduleAfterPause();
  }

  participantLeft(identity: string): void {
    if (this.speaking.delete(identity) && this.speaking.size === 0) this.scheduleAfterPause();
  }

  /** A new transcript line (human). */
  lineAdded(): void {
    this.newLines++;
  }

  agentFinishedSpeaking(): void {
    this.lastAgentSpokeAt = this.now();
  }

  notesUpdated(): void {
    if (this.speaking.size === 0) this.scheduleAfterPause();
  }

  /** Called every few seconds: wakes the brain when it asked to look again. */
  tick(): void {
    if (this.timer || this.checking || this.speaking.size > 0) return;
    if (this.startPending || this.now() >= this.nextCheckAt) this.scheduleAfterPause();
  }

  stop(): void {
    this.stopped = true;
    this.clearTimer();
  }

  private scheduleAfterPause(): void {
    const b = this.o.behaviour();
    if (this.stopped || !b) return;
    const silent = this.now() - this.lastHumanSpeechAt;
    this.clearTimer();
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.check();
    }, Math.max(0, b.limits.pauseMs - silent));
  }

  private clearTimer(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  private settle(r: Remark, reaction: Remark['reaction']): void {
    if (r.reaction !== 'pending' || reaction === 'pending') return;
    r.reaction = reaction;
    this.o.onReaction?.(r);
  }

  /** What the host's limits forbid right now (empty = the brain may speak). */
  private limitsBlocking(b: Behaviour, now: number): { blocked: boolean; until: number } {
    const l = b.limits;
    const waits: number[] = [];
    if (now - this.joinedAt < l.warmupSeconds * 1000) waits.push(this.joinedAt + l.warmupSeconds * 1000);
    if (this.lastAgentSpokeAt !== null && now - this.lastAgentSpokeAt < l.minGapSeconds * 1000) {
      waits.push(this.lastAgentSpokeAt + l.minGapSeconds * 1000);
    }
    const inWindow = this.remarks.filter((r) => now - r.at < 10 * 60_000);
    if (inWindow.length >= l.maxPerTenMinutes) {
      waits.push((inWindow[0]?.at ?? now) + 10 * 60_000);
    }
    return { blocked: waits.length > 0 || b.talkativeness <= 0, until: waits.length ? Math.max(...waits) : Infinity };
  }

  /** Exposed for tests. */
  async check(): Promise<BrainDecision | null> {
    const b = this.o.behaviour();
    if (this.stopped || this.checking || !b || this.speaking.size > 0 || !this.o.agentIdle()) return null;
    const now = this.now();
    const silence = now - this.lastHumanSpeechAt;
    if (silence < b.limits.pauseMs) return null;

    const event: BrainEvent = this.startPending ? 'start' : this.newLines > 0 ? 'pause' : 'timer';
    if (event !== 'start') {
      if (!this.enabled || this.quiet) return null;
      if (now - this.lastCheckAt < b.limits.minCheckSeconds * 1000) return null;
      if (event === 'timer' && now < this.nextCheckAt) return null;
      const limit = this.limitsBlocking(b, now);
      if (limit.blocked) {
        // Nothing may be said yet: look again once the limit lifts (no model call meanwhile).
        if (Number.isFinite(limit.until)) this.nextCheckAt = Math.max(this.nextCheckAt === Infinity ? 0 : this.nextCheckAt, limit.until);
        return null;
      }
    }

    const epochAtStart = this.epoch;
    this.checking = true;
    this.lastCheckAt = now;
    this.newLines = 0;
    let d: BrainDecision;
    try {
      d = await this.o.brain({
        event,
        now,
        joinedAt: this.joinedAt,
        behaviour: b,
        title: this.o.title,
        facilitator: this.o.facilitator(),
        present: this.o.present(),
        insights: this.o.insights(),
        transcript: this.o.transcript(),
        silenceMs: silence,
        remarks: this.remarks.slice(-8),
        learning: b.learnFromReactions ? this.o.learning() : [],
        prep: this.o.prep(),
        blocked: [],
      });
    } catch (err) {
      this.o.log?.('meeting brain failed', { err: String(err) });
      this.nextCheckAt = now + b.limits.minCheckSeconds * 1000;
      return null;
    } finally {
      this.checking = false;
      if (event === 'start') this.startPending = false;
    }

    for (const r of d.reactions ?? []) {
      const remark = this.remarks.find((x) => x.id === r.id);
      if (remark) this.settle(remark, r.reaction);
    }
    const recheck = Math.max(b.limits.minCheckSeconds, Math.min(d.recheckInSeconds || 0, 900));
    this.nextCheckAt = now + recheck * 1000;
    this.o.log?.('brain decision', { event, speak: d.speak, intent: d.intent, key: d.topicKey, reason: d.reason, recheck });

    const message = d.message.trim();
    if (!d.speak || !message) return d;

    const key = d.topicKey.trim();
    if (key && this.remarks.some((r) => r.topicKey === key && now - r.at < b.limits.repeatTopicMinutes * 60_000)) {
      return { ...d, speak: false, reason: `already raised "${key}" recently` };
    }
    // Someone started talking while the model was thinking: the moment has passed.
    if (this.epoch !== epochAtStart || this.speaking.size > 0 || this.stopped || !this.o.agentIdle()) {
      return { ...d, speak: false, reason: 'moment passed' };
    }
    if (event !== 'start' && (this.quiet || !this.enabled)) return { ...d, speak: false, reason: 'turned off meanwhile' };

    this.remarks.push({
      id: `r${++this.seq}`,
      at: this.now(),
      intent: d.intent.trim() || 'remark',
      topicKey: key,
      message,
      reaction: 'pending',
    });
    if (this.remarks.length > 50) this.remarks.shift();
    this.lastAgentSpokeAt = this.now();
    this.o.speak(message, d);
    return d;
  }
}
