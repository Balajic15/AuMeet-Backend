import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MeetingAnalyzer } from '../src/intel/analyzer.js';
import { matchPerson, normalize, type Person } from '../src/intel/normalize.js';
import { analystPrompt, ANALYST_SYSTEM } from '../src/intel/prompt.js';
import { renderNotes } from '../src/intel/render.js';
import { emptyInsights, modelOutputJsonSchema, type ModelOutput } from '../src/intel/schema.js';
import { MeetingTranscript } from '../src/transcript.js';

const people: Person[] = [
  { identity: 'user:1', name: 'Asha Rao', userId: '1' },
  { identity: 'user:2', name: 'Ben Ortiz', userId: '2' },
  { identity: 'guest:x', name: 'Chen', userId: null },
];

const emptyOut = (): ModelOutput => ({ summary: '', topics: [], decisions: [], actionItems: [], openQuestions: [] });

const disputedDb = (id = ''): ModelOutput['decisions'][number] => ({
  id,
  topic: 'Database',
  statement: 'Which database to use',
  status: 'disputed',
  options: ['MongoDB', 'PostgreSQL'],
  proposedBy: ['Asha Rao'],
  supporters: [],
  objectors: [],
  confirmationNeeded: 'Can we confirm which database the team has agreed to use?',
  contradicts: '',
  evidence: [1, 2, 3, 99],
});

const ctx = (through = 3) => ({ validLines: new Set([1, 2, 3]), people, analyzedThrough: through, now: new Date('2026-11-26T10:00:00Z') });

describe('normalize', () => {
  it('assigns ids, filters evidence to real lines and keeps the confirmation question', () => {
    const s = normalize(emptyInsights(), { ...emptyOut(), decisions: [disputedDb()] }, ctx());
    expect(s.decisions[0]).toMatchObject({
      id: 'd1',
      status: 'disputed',
      options: ['MongoDB', 'PostgreSQL'],
      evidence: [1, 2, 3],
      confirmationNeeded: 'Can we confirm which database the team has agreed to use?',
    });
    expect(s.analyzedThrough).toBe(3);
  });

  it('keeps ids stable, keeps items the model forgot, and clears confirmation once agreed', () => {
    const first = normalize(
      emptyInsights(),
      { ...emptyOut(), decisions: [disputedDb()], openQuestions: [{ id: '', question: 'Budget?', askedBy: 'Ben Ortiz', status: 'open', evidence: [2] }] },
      ctx(),
    );
    const agreed = { ...disputedDb('d1'), status: 'agreed' as const, statement: 'Use PostgreSQL', options: [] };
    const second = normalize(first, { ...emptyOut(), decisions: [agreed] }, ctx(3));
    expect(second.decisions).toHaveLength(1);
    expect(second.decisions[0]).toMatchObject({ id: 'd1', status: 'agreed', confirmationNeeded: null });
    expect(second.decisions[0]!.firstSeenAt).toBe(first.decisions[0]!.firstSeenAt);
    // The model omitted the question – it must survive.
    expect(second.openQuestions.map((q) => q.question)).toEqual(['Budget?']);
  });

  it('matches task owners to participants and validates due dates', () => {
    const s = normalize(
      emptyInsights(),
      {
        ...emptyOut(),
        actionItems: [
          { id: '', task: 'Draft schema', owner: 'Asha', deadline: 'by Friday', dueDate: '2026-11-27', status: 'open', evidence: [2] },
          { id: '', task: 'Check pricing', owner: 'Chen', deadline: '', dueDate: 'next week', status: 'open', evidence: [] },
          { id: '', task: 'Book room', owner: 'Dana', deadline: '', dueDate: '', status: 'open', evidence: [] },
          { id: '', task: '   ', owner: '', deadline: '', dueDate: '', status: 'open', evidence: [] },
        ],
      },
      ctx(),
    );
    expect(s.actionItems).toHaveLength(3);
    expect(s.actionItems[0]).toMatchObject({ id: 't1', owner: 'Asha Rao', ownerUserId: '1', dueDate: '2026-11-27', deadline: 'by Friday' });
    expect(s.actionItems[1]).toMatchObject({ owner: 'Chen', ownerIdentity: 'guest:x', ownerUserId: null, dueDate: null });
    expect(s.actionItems[2]).toMatchObject({ owner: 'Dana', ownerIdentity: null });
  });

  it('does not guess between people who share a first name', () => {
    const twins: Person[] = [...people, { identity: 'user:3', name: 'Asha Iyer', userId: '3' }];
    expect(matchPerson('Asha', twins)).toBeNull();
    expect(matchPerson('asha iyer', twins)?.userId).toBe('3');
  });
});

describe('prompt + schema', () => {
  it('produces a Gemini-ready JSON schema', () => {
    const schema = modelOutputJsonSchema();
    expect(schema['$schema']).toBeUndefined();
    expect(Object.keys(schema['properties'] as object)).toEqual(['summary', 'topics', 'decisions', 'actionItems', 'openQuestions', 'statementChanges', 'keyPoints', 'assumptions', 'risks', 'copilot', 'progress']);
  });

  it('numbers transcript lines and teaches the disputed-decision rule', () => {
    const t = new MeetingTranscript('abc-defg-hij', 's');
    const at = Date.UTC(2026, 10, 26, 10, 0);
    t.add({ speakerId: 'a', speakerName: 'A', userId: null, isAgent: false, channel: 'voice', text: "Let's use MongoDB.", language: 'en', at });
    const p = analystPrompt({ title: 'Kickoff', meetingDate: new Date(at), participants: ['A'], current: emptyInsights(), lines: [...t.all], final: false });
    expect(p).toContain("#1 [10:00] A: Let's use MongoDB.");
    expect(p).toContain('Meeting date: 2026-11-26 (Thursday)');
    expect(ANALYST_SYSTEM).toContain('Okay, let\'s proceed');
  });

  it('renders notes for the voice assistant', () => {
    const s = normalize(emptyInsights(), { ...emptyOut(), summary: 'Kickoff.', decisions: [disputedDb()] }, ctx());
    expect(renderNotes(s)).toBe('Summary so far: Kickoff.\nDecisions:\n- [DISPUTED] Which database to use (options: MongoDB, PostgreSQL)');
  });
});

describe('MeetingAnalyzer', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  function setup(analyze = vi.fn(async (): Promise<ModelOutput> => ({ ...emptyOut(), decisions: [disputedDb()] }))) {
    const transcript = new MeetingTranscript('abc-defg-hij', 's');
    const updates: unknown[] = [];
    const analyzer = new MeetingAnalyzer({
      title: 'Kickoff',
      transcript,
      analyze,
      people: () => people,
      onUpdate: (i) => updates.push(i),
      batchSize: 3,
      idleMs: 10_000,
      minIntervalMs: 5_000,
      now: () => Date.now(),
    });
    const say = (text: string) => {
      transcript.add({ speakerId: 'user:1', speakerName: 'Asha Rao', userId: '1', isAgent: false, channel: 'voice', text, language: 'en', at: Date.now() });
      analyzer.notify();
    };
    return { analyzer, analyze, updates, say };
  }

  it('runs after a batch of lines, and after a quiet period for fewer lines', async () => {
    const { analyze, say } = setup();
    say('one');
    say('two');
    await vi.advanceTimersByTimeAsync(9_000);
    expect(analyze).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1_500);
    expect(analyze).toHaveBeenCalledTimes(1);

    say('three');
    say('four');
    say('five'); // batch reached, but still respects the minimum interval
    await vi.advanceTimersByTimeAsync(1_000);
    expect(analyze).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(4_500);
    expect(analyze).toHaveBeenCalledTimes(2);
  });

  it('keeps previous notes when the model fails, then recovers', async () => {
    const analyze = vi.fn()
      .mockRejectedValueOnce(new Error('quota'))
      .mockResolvedValue({ ...emptyOut(), decisions: [disputedDb()] });
    const { analyzer, say } = setup(analyze);
    say('a'); say('b'); say('c');
    await vi.advanceTimersByTimeAsync(0);
    expect(analyzer.insights.decisions).toHaveLength(0);
    say('d');
    await vi.advanceTimersByTimeAsync(20_000);
    expect(analyzer.insights.decisions[0]?.status).toBe('disputed');
  });

  it('does a final pass on finish and stops scheduling', async () => {
    const { analyzer, analyze, say } = setup();
    say('only line');
    const final = await analyzer.finish();
    expect(analyze).toHaveBeenCalledTimes(1);
    expect((analyze.mock.calls[0] as unknown as string[])[1]).toContain('The meeting has ENDED');
    expect(final.analyzedThrough).toBe(1);
    say('after end');
    await vi.advanceTimersByTimeAsync(60_000);
    expect(analyze).toHaveBeenCalledTimes(1);
  });
});
