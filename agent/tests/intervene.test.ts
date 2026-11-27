import { describe, expect, it, vi } from 'vitest';
import { proactivityCommand } from '../src/addressing.js';
import { findCandidates } from '../src/intervene/candidates.js';
import { InterventionController } from '../src/intervene/controller.js';
import type { Verdict } from '../src/intervene/judge.js';
import { judgePrompt } from '../src/intervene/judge.js';
import { emptyInsights, type ActionItem, type Decision, type Insights } from '../src/intel/schema.js';
import type { Utterance } from '../src/transcript.js';

const T0 = Date.UTC(2026, 10, 26, 10, 0, 0);
const iso = (ms: number) => new Date(ms).toISOString();

function decision(p: Partial<Decision> = {}): Decision {
  return {
    id: 'd1',
    topic: 'Database',
    statement: 'Which database to use',
    status: 'disputed',
    options: ['MongoDB', 'PostgreSQL'],
    proposedBy: ['A'],
    supporters: [],
    objectors: [],
    confirmationNeeded: 'Can we confirm which database the team has agreed to use?',
    evidence: [1, 2, 3],
    firstSeenAt: iso(T0),
    updatedAt: iso(T0),
    ...p,
  };
}

function task(p: Partial<ActionItem> = {}): ActionItem {
  return {
    id: 't1', task: 'Write the migration plan', owner: null, ownerIdentity: null, ownerUserId: null,
    deadline: null, dueDate: null, status: 'open', evidence: [4], firstSeenAt: iso(T0), updatedAt: iso(T0), ...p,
  };
}

const withNotes = (p: Partial<Insights>): Insights => ({ ...emptyInsights(), ...p });

function lines(n: number, from = T0): Utterance[] {
  return Array.from({ length: n }, (_, i) => ({
    id: i + 1, speakerId: i % 2 ? 'user:b' : 'user:a', speakerName: i % 2 ? 'B' : 'A', userId: null,
    isAgent: false, channel: 'voice' as const, text: `line ${i + 1}`, language: 'en', at: from + i * 1000,
  }));
}

describe('findCandidates', () => {
  it('asks to confirm a disputed decision once it has been around a little while', () => {
    const notes = withNotes({ decisions: [decision()] });
    expect(findCandidates(notes, [], T0 + 5_000, new Set())).toEqual([]);
    const [c] = findCandidates(notes, [], T0 + 20_000, new Set());
    expect(c).toMatchObject({ kind: 'confirm_decision', key: 'confirm:d1', suggestion: 'Can we confirm which database the team has agreed to use?' });
    expect(c!.goal).toContain('MongoDB vs PostgreSQL');
  });

  it('never raises agreed decisions or already-raised issues', () => {
    expect(findCandidates(withNotes({ decisions: [decision({ status: 'agreed', confirmationNeeded: null })] }), [], T0 + 60_000, new Set())).toEqual([]);
    expect(findCandidates(withNotes({ decisions: [decision()] }), [], T0 + 60_000, new Set(['confirm:d1']))).toEqual([]);
  });

  it('asks who owns an unassigned task after a while, not for owned or done tasks', () => {
    const notes = withNotes({ actionItems: [task(), task({ id: 't2', owner: 'Ravi' }), task({ id: 't3', status: 'done' })] });
    expect(findCandidates(notes, [], T0 + 30_000, new Set())).toEqual([]);
    expect(findCandidates(notes, [], T0 + 50_000, new Set()).map((c) => c.key)).toEqual(['owner:t1']);
  });

  it('offers a summary when a dispute goes in circles, ranked below the confirmation', () => {
    const notes = withNotes({ decisions: [decision()] });
    const now = T0 + 5 * 60_000;
    const keys = findCandidates(notes, lines(20), now, new Set()).map((c) => c.key);
    expect(keys).toEqual(['confirm:d1', 'circling:d1']);
    expect(findCandidates(notes, lines(5), now, new Set()).map((c) => c.key)).toEqual(['confirm:d1']);
  });
});

describe('proactivityCommand', () => {
  it.each([
    ['AuMeet, stay quiet for now', 'quiet'],
    ["AuMeet please don't interrupt us", 'quiet'],
    ['AuMeet, only speak when we ask you', 'quiet'],
    ['AuMeet you can speak up again', 'resume'],
    ['AuMeet, feel free to jump in', 'resume'],
    ['AuMeet what did we decide?', null],
    ['stay quiet everyone', null], // not addressed to the AI
  ])('%s → %s', (text, expected) => expect(proactivityCommand(text)).toBe(expected));
});

describe('InterventionController', () => {
  function setup(opts: { verdict?: Verdict; enabled?: boolean; idle?: boolean; notes?: Insights } = {}) {
    let now = T0;
    const spoken: string[] = [];
    let resolveJudge: ((v: Verdict) => void) | null = null;
    const judge = vi.fn(
      () =>
        new Promise<Verdict>((r) => {
          if (opts.verdict) r(opts.verdict);
          else resolveJudge = r;
        }),
    );
    const c = new InterventionController({
      enabled: opts.enabled ?? true,
      judge,
      speak: (m) => spoken.push(m),
      insights: () => opts.notes ?? withNotes({ decisions: [decision()] }),
      transcript: () => lines(3),
      agentIdle: () => opts.idle ?? true,
      pauseMs: 2000,
      cooldownMs: 90_000,
      warmupMs: 30_000,
      now: () => now,
    });
    return {
      c, judge, spoken,
      at: (ms: number) => { now = T0 + ms; },
      resolve: (v: Verdict) => resolveJudge?.(v),
    };
  }
  const yes: Verdict = { speak: true, message: 'Can we confirm which database we agreed on?', reason: 'unresolved' };

  it('speaks at a natural pause once warm-up has passed, and only once per issue', async () => {
    const s = setup({ verdict: yes });
    s.at(10_000);
    s.c.humanSpeechStarted('user:a');
    s.c.humanSpeechEnded('user:a');
    s.at(12_500);
    expect(await s.c.check()).toBeNull(); // still warming up
    s.at(40_000);
    await s.c.check();
    expect(s.spoken).toEqual(['Can we confirm which database we agreed on?']);
    s.at(200_000);
    await s.c.check();
    expect(s.spoken).toHaveLength(1);
  });

  it('stays silent while anyone is talking or the pause is too short', async () => {
    const s = setup({ verdict: yes });
    s.at(40_000);
    s.c.humanSpeechStarted('user:a');
    expect(await s.c.check()).toBeNull();
    s.c.humanSpeechEnded('user:a');
    s.at(41_000);
    expect(await s.c.check()).toBeNull();
    expect(s.judge).not.toHaveBeenCalled();
  });

  it('drops the idea if someone starts talking while the model is deciding', async () => {
    const s = setup();
    s.at(40_000);
    const pending = s.c.check();
    s.c.humanSpeechStarted('user:b');
    s.resolve(yes);
    expect((await pending)?.reason).toBe('moment passed');
    expect(s.spoken).toEqual([]);
  });

  it('respects the cooldown after the AI last spoke, quiet mode, and the host setting', async () => {
    const s = setup({ verdict: yes });
    s.at(35_000);
    s.c.agentFinishedSpeaking();
    s.at(60_000);
    expect(await s.c.check()).toBeNull();

    s.c.setQuiet(true);
    s.at(200_000);
    expect(await s.c.check()).toBeNull();
    s.c.setQuiet(false);
    await s.c.check();
    expect(s.spoken).toHaveLength(1);

    const off = setup({ verdict: yes, enabled: false });
    off.at(200_000);
    expect(await off.c.check()).toBeNull();
  });

  it('follows the host switching proactivity off and on during the meeting', async () => {
    const s = setup({ verdict: yes });
    s.c.setEnabled(false);
    s.at(200_000);
    expect(await s.c.check()).toBeNull();
    expect(s.judge).not.toHaveBeenCalled();
    s.c.setEnabled(true);
    await s.c.check();
    expect(s.spoken).toHaveLength(1);
  });

  it('retries a "not now" verdict once, later', async () => {
    const s = setup({ verdict: { speak: false, message: '', reason: 'still discussing' } });
    s.at(40_000);
    await s.c.check();
    s.at(50_000);
    await s.c.check(); // too soon to retry
    s.at(75_000);
    await s.c.check();
    s.at(200_000);
    await s.c.check(); // attempts exhausted
    expect(s.judge).toHaveBeenCalledTimes(2);
    expect(s.spoken).toEqual([]);
  });

  it('builds a judge prompt with the goal, notes and recent lines', () => {
    const [cand] = findCandidates(withNotes({ decisions: [decision()] }), [], T0 + 60_000, new Set());
    const p = judgePrompt({ candidate: cand!, insights: withNotes({ decisions: [decision()] }), recent: lines(2), silenceMs: 2500 });
    expect(p).toContain('Nobody has spoken for 2.5 seconds.');
    expect(p).toContain('[DISPUTED] Which database to use');
    expect(p).toContain('[10:00] A: line 1');
  });
});
