import { describe, expect, it, vi } from 'vitest';
import { describeBehaviour, mergeLayers, resolveBehaviour, wakeMatcher, type Behaviour } from '../src/behaviour.js';
import { brainPrompt, type BrainDecision, type BrainInput } from '../src/brain.js';
import { emptyInsights } from '../src/intel/schema.js';
import { Moderator } from '../src/intervene/moderator.js';
import { renderLearning, summarise } from '../src/learning.js';
import { geminiRouter, routePrompt } from '../src/router.js';
import type { Utterance } from '../src/transcript.js';

// Test fixture only – the real default lives in MongoDB (seeded by the server).
const base: Behaviour = {
  name: 'Nova',
  wakeWords: ['no va', 'नोवा'],
  talkativeness: 0.5,
  tone: 'neutral',
  replyLength: 'brief',
  watchFor: { decisions: true, owners: true, disputes: true, goal: true, time: true, followUps: true, contradictions: true },
  customInstructions: '',
  learnFromReactions: true,
  limits: { minGapSeconds: 60, maxPerTenMinutes: 3, pauseMs: 1500, warmupSeconds: 20, repeatTopicMinutes: 15, minCheckSeconds: 5 },
  engine: { analysisBatchLines: 4, analysisIdleSeconds: 12, analysisMinIntervalSeconds: 15, contextLines: 30 },
};

const T0 = Date.UTC(2026, 10, 28, 10, 0, 0);
const line = (id: number, text: string, who = 'Asha', at = T0 + id * 1000): Utterance => ({
  id, speakerId: `user:${who}`, speakerName: who, userId: null, isAgent: false, channel: 'voice', text, language: 'en', at,
});
const decision = (p: Partial<BrainDecision> = {}): BrainDecision => ({
  speak: true, intent: 'confirm_decision', topicKey: 'decision:db', addressee: 'everyone',
  message: 'Can we confirm the database?', reason: 'unconfirmed', recheckInSeconds: 30, reactions: [], ...p,
});

describe('behaviour settings', () => {
  it('layers system default ← account ← meeting; arrays replace, objects merge', () => {
    const b = resolveBehaviour(base, { tone: 'casual', limits: { minGapSeconds: 120 } }, { talkativeness: 0.9, wakeWords: ['hey nova'] });
    expect(b).toMatchObject({ tone: 'casual', talkativeness: 0.9, wakeWords: ['hey nova'] });
    expect(b!.limits).toMatchObject({ minGapSeconds: 120, maxPerTenMinutes: 3 });
    expect(mergeLayers({ a: { b: 1 } }, { a: null }, undefined)).toEqual({ a: { b: 1 } });
  });

  it('rejects an invalid or missing profile instead of inventing defaults', () => {
    expect(resolveBehaviour({ name: 'x' })).toBeNull();
    expect(resolveBehaviour(base, { talkativeness: 7 })).toBeNull();
  });

  it('recognises the configured name and its spellings in any script, as whole words', () => {
    const wake = wakeMatcher(base);
    expect(wake('Nova, what did we decide?')).toBe(true);
    expect(wake('ok no-va can you summarise')).toBe(true);
    expect(wake('नोवा, सारांश बताओ')).toBe(true);
    expect(wake('the supernova release')).toBe(false);
    expect(wakeMatcher({ ...base, name: 'Ada', wakeWords: [] })('Ada?')).toBe(true);
  });

  it('describes the settings for the model', () => {
    const text = describeBehaviour({ ...base, watchFor: { ...base.watchFor, time: false }, customInstructions: 'Mostly speak Hindi' });
    expect(text).toContain('Your name is Nova.');
    expect(text).toContain('Talkativeness 0.50 on a 0–1 scale: speak up when it clearly helps');
    expect(text).not.toContain(' time,');
    expect(text).toContain("Host's instructions: Mostly speak Hindi");
  });
});

describe('meeting brain prompt', () => {
  it('gives the model the live situation, its own remarks and the team’s reactions', () => {
    const input: BrainInput = {
      event: 'pause', now: T0 + 10 * 60_000, joinedAt: T0, behaviour: base, title: 'Billing', facilitator: true,
      present: ['Asha', 'Ben'], insights: emptyInsights(), transcript: [line(1, 'MongoDB?'), line(2, 'PostgreSQL!', 'Ben')],
      silenceMs: 2500, prep: 'MEETING GOAL: pick a database',
      remarks: [{ id: 'r1', at: T0 + 8 * 60_000, intent: 'assign_owner', topicKey: 'owner:docs', message: 'Who takes the docs?', reaction: 'pending' }],
      learning: summarise([{ intent: 'time_check', reaction: 'ignored' }, { intent: 'time_check', reaction: 'ignored' }]),
      blocked: [],
    };
    const p = brainPrompt(input);
    expect(p).toContain('EVENT: pause');
    expect(p).toContain('People present: Asha, Ben. Silence right now: 2.5 s.');
    expect(p).toContain('FACILITATOR: on');
    expect(p).toContain('MEETING GOAL: pick a database');
    expect(p).toContain('id r1 (120s ago, assign_owner, key "owner:docs", pending): "Who takes the docs?"');
    expect(p).toContain('- time_check: engaged 0, ignored 2, pushed back 0');
    expect(p).toContain('Ben: PostgreSQL!');
  });

  it('summarises learning by intent', () => {
    expect(renderLearning([])).toBe('');
    expect(summarise([{ intent: 'a', reaction: 'engaged' }, { intent: 'b', reaction: 'rejected' }, { intent: 'a', reaction: 'ignored' }]))
      .toEqual([{ intent: 'a', engaged: 1, ignored: 1, rejected: 0 }, { intent: 'b', engaged: 0, ignored: 0, rejected: 1 }]);
  });
});

describe('router', () => {
  it('never answers room questions unless the host allows it', async () => {
    const call = vi.fn(async () => ({ respond: true, kind: 'room_question', reason: 'q' })) as never;
    const route = geminiRouter(call);
    const input = { line: line(3, 'What is the budget?'), recent: [], behaviour: base, answerRoomQuestions: false, lastAnswer: null, participants: ['Asha'], peoplePresent: 2 };
    expect((await route(input)).respond).toBe(false);
    expect((await route({ ...input, answerRoomQuestions: true })).respond).toBe(true);
    expect(routePrompt(input)).toContain('AI name: Nova (also heard as: no va, नोवा)');
  });
});

function setup(over: Partial<{ behaviour: Behaviour | null; enabled: boolean; brain: ReturnType<typeof vi.fn> }> = {}) {
  let now = T0;
  const speak = vi.fn();
  const brain = over.brain ?? vi.fn(async () => decision());
  const reactions: string[] = [];
  const m = new Moderator({
    brain: brain as never, speak, enabled: over.enabled ?? true, title: 'Billing',
    behaviour: () => (over.behaviour === undefined ? base : over.behaviour),
    insights: () => emptyInsights(), transcript: () => [line(1, 'hi')], present: () => ['Asha'],
    agentIdle: () => true, facilitator: () => false, prep: () => '', learning: () => [],
    onReaction: (r) => reactions.push(`${r.intent}:${r.reaction}`),
    now: () => now,
  });
  return { m, speak, brain, reactions, at: (ms: number) => (now = T0 + ms) };
}

describe('moderator (enforces the host’s limits; the model decides the rest)', () => {
  it('lets the brain introduce itself on start, even during warm-up', async () => {
    const t = setup({ brain: vi.fn(async () => decision({ intent: 'greet', topicKey: 'greet', message: 'Hi Asha, I’m Nova.' })) });
    t.m.start();
    t.at(2000);
    await t.m.check();
    expect(t.brain.mock.calls[0]![0]).toMatchObject({ event: 'start' });
    expect(t.speak).toHaveBeenCalledWith('Hi Asha, I’m Nova.', expect.anything());
  });

  it('respects warm-up, gap and per-10-minute limits without calling the model', async () => {
    const t = setup();
    t.m.lineAdded();
    t.at(10_000); // inside the 20 s warm-up
    expect(await t.m.check()).toBeNull();
    expect(t.brain).not.toHaveBeenCalled();
    t.at(25_000);
    await t.m.check();
    expect(t.speak).toHaveBeenCalledTimes(1);
    t.m.lineAdded();
    t.at(60_000); // only 35 s after speaking (min gap 60 s)
    expect(await t.m.check()).toBeNull();
    expect(t.brain).toHaveBeenCalledTimes(1);
  });

  it('never repeats the same issue within the repeat window, and settles reactions', async () => {
    const brain = vi.fn(async () => decision());
    const t = setup({ brain });
    t.at(30_000);
    t.m.lineAdded();
    await t.m.check();
    brain.mockResolvedValueOnce(decision({ reactions: [{ id: 'r1', reaction: 'engaged' }] }));
    t.at(120_000);
    t.m.lineAdded();
    const d = await t.m.check();
    expect(d?.speak).toBe(false);
    expect(d?.reason).toContain('already raised "decision:db"');
    expect(t.speak).toHaveBeenCalledTimes(1);
    expect(t.reactions).toEqual(['confirm_decision:engaged']);
  });

  it('drops the remark if someone starts talking while the model thinks', async () => {
    let release!: (d: BrainDecision) => void;
    const brain = vi.fn(() => new Promise<BrainDecision>((r) => (release = r)));
    const t = setup({ brain });
    t.at(30_000);
    t.m.lineAdded();
    const pending = t.m.check();
    t.m.humanSpeechStarted('user:Ben');
    release(decision());
    expect((await pending)?.reason).toBe('moment passed');
    expect(t.speak).not.toHaveBeenCalled();
  });

  it('being told to be quiet counts as push-back and stops remarks', async () => {
    const t = setup();
    t.at(30_000);
    t.m.lineAdded();
    await t.m.check();
    t.m.setQuiet(true);
    expect(t.reactions).toEqual(['confirm_decision:rejected']);
    t.at(200_000);
    t.m.lineAdded();
    expect(await t.m.check()).toBeNull();
  });

  it('stays silent without a valid profile or when the host turned speaking up off', async () => {
    const none = setup({ behaviour: null });
    none.m.start();
    none.at(30_000);
    expect(await none.m.check()).toBeNull();
    const off = setup({ enabled: false });
    off.at(30_000);
    off.m.lineAdded();
    expect(await off.m.check()).toBeNull();
    expect(off.brain).not.toHaveBeenCalled();
  });
});
