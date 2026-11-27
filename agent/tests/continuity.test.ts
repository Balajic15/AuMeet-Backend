import { describe, expect, it, vi } from 'vitest';
import { buildContinuity, renderCarryover } from '../src/carryover.js';
import { MeetingAnalyzer } from '../src/intel/analyzer.js';
import { normalize } from '../src/intel/normalize.js';
import { analystPrompt } from '../src/intel/prompt.js';
import { emptyInsights, type AgendaProgress, type Decision, type Insights, type ModelOutput } from '../src/intel/schema.js';
import { findCandidates } from '../src/intervene/candidates.js';
import { InterventionController } from '../src/intervene/controller.js';
import { judgePrompt } from '../src/intervene/judge.js';
import { MeetingTranscript, type Utterance } from '../src/transcript.js';

const T0 = Date.UTC(2026, 10, 26, 10, 0, 0);
const iso = (ms: number) => new Date(ms).toISOString();
const withNotes = (p: Partial<Insights>): Insights => ({ ...emptyInsights(), ...p });
const say = (n: number, from = T0): Utterance[] =>
  Array.from({ length: n }, (_, i) => ({
    id: i + 1, speakerId: 'user:a', speakerName: 'Asha', userId: null, isAgent: false,
    channel: 'voice' as const, text: `line ${i + 1}`, language: 'en', at: from + i * 1000,
  }));

const sessions = [
  {
    meetingCode: 'abc-defg-hij', sessionId: 's1', title: 'Billing kickoff', startedAt: new Date('2026-11-12T10:00:00Z'),
    insights: { decisions: [{ statement: 'Use PostgreSQL for billing', status: 'agreed' }], actionItems: [] },
  },
  {
    meetingCode: 'abc-defg-hij', sessionId: 's2', title: 'Billing sync', startedAt: new Date('2026-11-19T10:00:00Z'),
    insights: {
      decisions: [
        { statement: 'Which queue to use', status: 'disputed', options: ['SQS', 'Kafka'] },
        { statement: 'Use PostgreSQL for billing', status: 'agreed' },
        { statement: 'Ship the beta on Friday', status: 'agreed' },
      ],
      actionItems: [
        { task: 'Write the migration plan', owner: 'Ravi', dueDate: '2026-11-21', status: 'open' },
        { task: 'Book the review', owner: 'Ben', dueDate: '2026-12-02', status: 'open' },
        { task: 'Send the invite', owner: 'Ben', dueDate: null, status: 'done' },
      ],
    },
  },
];

describe('continuity between meetings', () => {
  it('carries over the latest session’s open items and flags overdue tasks', () => {
    const { carryover, pastDecisions } = buildContinuity(sessions, new Date('2026-11-26T09:00:00Z'));
    expect(carryover).toMatchObject({ fromTitle: 'Billing sync', fromDate: '2026-11-19' });
    expect(carryover!.decisions).toEqual([{ statement: 'Which queue to use', options: ['SQS', 'Kafka'] }]);
    expect(carryover!.tasks).toEqual([
      { task: 'Write the migration plan', owner: 'Ravi', dueDate: '2026-11-21', overdue: true },
      { task: 'Book the review', owner: 'Ben', dueDate: '2026-12-02', overdue: false },
    ]);
    // newest first, no duplicates
    expect(pastDecisions.map((p) => [p.ref, p.statement, p.date])).toEqual([
      ['P1', 'Use PostgreSQL for billing', '2026-11-19'],
      ['P2', 'Ship the beta on Friday', '2026-11-19'],
    ]);
    expect(renderCarryover(carryover)).toContain('Write the migration plan – Ravi, due 2026-11-21 (OVERDUE)');
  });

  it('has nothing to carry over when everything was settled', () => {
    const settled = [{ ...sessions[0]! }];
    expect(buildContinuity(settled, new Date()).carryover).toBeNull();
    expect(buildContinuity([], new Date())).toEqual({ carryover: null, pastDecisions: [] });
  });

  it('maps the model’s "contradicts" id to the earlier decision and keeps it', () => {
    const { pastDecisions } = buildContinuity(sessions, new Date());
    const out: ModelOutput = {
      summary: '', topics: [], actionItems: [], openQuestions: [],
      decisions: [{
        id: '', topic: 'DB', statement: 'Move billing to MongoDB', status: 'proposed', options: [], proposedBy: ['Ben'],
        supporters: [], objectors: [], confirmationNeeded: '', contradicts: 'p1', evidence: [1],
      }],
    };
    const ctx = { validLines: new Set([1]), people: [], analyzedThrough: 1, now: new Date(T0), pastDecisions };
    const s1 = normalize(emptyInsights(), out, ctx);
    expect(s1.decisions[0]!.contradicts).toMatchObject({ statement: 'Use PostgreSQL for billing', date: '2026-11-19' });
    // A later run that no longer mentions it does not erase the warning; an unknown id is ignored.
    const s2 = normalize(s1, { ...out, decisions: [{ ...out.decisions[0]!, id: 'd1', contradicts: 'P9' }] }, ctx);
    expect(s2.decisions[0]!.contradicts?.ref).toBe('P1');
    expect(analystPrompt({ title: 't', meetingDate: new Date(T0), participants: [], current: s2, lines: [], final: false, pastDecisions }))
      .toContain('P1 [2026-11-19, "Billing sync"]: Use PostgreSQL for billing');
  });

  it('keeps the carryover and seeds goal/agenda before the first analysis', async () => {
    const transcript = new MeetingTranscript('abc-defg-hij', 'job', null);
    const analyze = vi.fn(async () => ({ summary: 's', topics: [], decisions: [], actionItems: [], openQuestions: [] }));
    const a = new MeetingAnalyzer({ title: 't', transcript, analyze, people: () => [], onUpdate: () => {} });
    const { carryover } = buildContinuity(sessions, new Date('2026-11-26T09:00:00Z'));
    a.seed({ carryover, goal: 'Pick a queue', agenda: [{ id: 'followups', title: 'Follow-ups', minutes: null }, { id: 'a1', title: 'Queue', minutes: 10 }], now: new Date(T0) });
    expect(a.insights.goal).toMatchObject({ text: 'Pick a queue', status: 'on_track' });
    expect(a.insights.agenda.map((x) => [x.id, x.status])).toEqual([['followups', 'not_started'], ['a1', 'not_started']]);
    transcript.add({ speakerId: 'user:a', speakerName: 'Asha', userId: null, isAgent: false, channel: 'voice', text: 'hi', language: 'en', at: T0 });
    await a.finish();
    expect(a.insights.carryover?.fromTitle).toBe('Billing sync');
  });
});

describe('new reasons to speak up', () => {
  const carryover = buildContinuity(sessions, new Date('2026-11-26T09:00:00Z')).carryover;

  it('follows up on last meeting once people are talking (not in facilitator mode)', () => {
    const notes = withNotes({ carryover });
    expect(findCandidates(notes, [], T0 + 40_000, new Set())).toEqual([]);
    const [c] = findCandidates(notes, say(1), T0 + 40_000, new Set());
    expect(c).toMatchObject({ kind: 'carryover', key: 'carryover', minGapMs: 20_000 });
    expect(c!.goal).toContain('Ravi had "Write the migration plan" due 2026-11-21 (overdue)');
    expect(findCandidates(notes, say(1), T0 + 40_000, new Set(['carryover']))).toEqual([]);
    // the facilitator's opening covers it instead
    expect(findCandidates(notes, say(1), T0 + 40_000, new Set(), undefined, { facilitator: true }).map((x) => x.kind)).toEqual(['open_meeting']);
  });

  it('flags a contradiction with an earlier agreed decision', () => {
    const d: Decision = {
      id: 'd1', topic: 'DB', statement: 'Move billing to MongoDB', status: 'proposed', options: [], proposedBy: ['Ben'],
      supporters: [], objectors: [], confirmationNeeded: null, evidence: [1], firstSeenAt: iso(T0), updatedAt: iso(T0),
      contradicts: { ref: 'P1', statement: 'Use PostgreSQL for billing', date: '2026-11-19', title: 'Billing sync' },
    };
    const [c] = findCandidates(withNotes({ decisions: [d] }), say(3), T0 + 60_000, new Set());
    expect(c).toMatchObject({ kind: 'contradiction', key: 'contradiction:d1' });
    expect(c!.suggestion).toBe('Just flagging: on 2026-11-19 we agreed to use postgresql for billing. Are we changing that?');
    expect(findCandidates(withNotes({ decisions: [{ ...d, status: 'rejected' }] }), say(3), T0 + 60_000, new Set())).toEqual([]);
  });

  const agenda = (p: Array<Partial<AgendaProgress>>): AgendaProgress[] =>
    p.map((x, i) => ({ id: `a${i + 1}`, title: `Item ${i + 1}`, minutes: 10, status: 'not_started', note: '', startedAt: null, doneAt: null, ...x }));

  it('facilitator: opening early, a transition when an item is done, a wrap-up near the end', () => {
    const f = { facilitator: true };
    const open = findCandidates(withNotes({ agenda: agenda([{}, {}]) }), [], T0 + 30_000, new Set(), undefined, f);
    expect(open[0]).toMatchObject({ kind: 'open_meeting', longForm: true, minGapMs: 0 });
    expect(open[0]!.goal).toContain('Item 1 (10 min), Item 2 (10 min) – 20 minutes in total');
    // not in a meeting that's long underway
    expect(findCandidates(withNotes({}), say(20), T0 + 30_000, new Set(), undefined, f).some((c) => c.kind === 'open_meeting')).toBe(false);

    const afterFirst = withNotes({ agenda: agenda([{ status: 'done', startedAt: iso(T0), doneAt: iso(T0 + 9 * 60_000), note: 'Picked SQS' }, {}]) });
    const raised = new Set(['open']);
    const next = findCandidates(afterFirst, say(5), T0 + 9.5 * 60_000, raised, undefined, f).find((c) => c.kind === 'agenda_next');
    expect(next).toMatchObject({ key: 'next:a1' });
    expect(next!.suggestion).toBe('That covers Item 1. Next up: Item 2, 10 minutes.');
    // no transition while the next item is already being discussed, and none without facilitator mode
    expect(findCandidates(withNotes({ agenda: agenda([{ status: 'done', doneAt: iso(T0) }, { status: 'in_progress', startedAt: iso(T0) }, {}]) }), say(5), T0 + 60_000, raised, undefined, f).some((c) => c.kind === 'agenda_next')).toBe(false);
    expect(findCandidates(afterFirst, say(5), T0 + 9.5 * 60_000, raised).some((c) => c.kind === 'agenda_next')).toBe(false);

    const wrapNotes = withNotes({ agenda: agenda([{ status: 'done', doneAt: iso(T0) }, { status: 'in_progress', startedAt: iso(T0 + 10 * 60_000) }]) });
    expect(findCandidates(wrapNotes, say(5), T0 + 17 * 60_000, raised, undefined, f).some((c) => c.kind === 'wrap_up')).toBe(false);
    const wrap = findCandidates(wrapNotes, say(5), T0 + 18 * 60_000, raised, undefined, f);
    expect(wrap[0]).toMatchObject({ kind: 'wrap_up', key: 'wrapup', longForm: true });
  });

  it('controller: short gap for follow-ups, facilitation hint for the judge, works in silence via tick', async () => {
    let now = T0;
    const judge = vi.fn(async () => ({ speak: true, message: 'From last time…', reason: 'ok' }));
    const speak = vi.fn();
    const c = new InterventionController({
      judge, speak, enabled: true, insights: () => withNotes({ carryover }), transcript: () => say(1, T0),
      agentIdle: () => true, now: () => now, facilitator: () => false,
    });
    c.agentFinishedSpeaking(); // the greeting
    now = T0 + 31_000; // past warm-up, 31 s after the greeting (< 90 s default cooldown)
    const v = await c.check();
    expect(v?.speak).toBe(true);
    expect(speak).toHaveBeenCalledWith('From last time…', expect.objectContaining({ kind: 'carryover' }));

    const prompt = judgePrompt({ candidate: { key: 'open', kind: 'open_meeting', priority: 50, goal: 'g', suggestion: 's' }, insights: emptyInsights(), recent: [], silenceMs: 3000 });
    expect(prompt).toContain('facilitation step the host switched on');
    expect(judgePrompt({ candidate: { key: 'x', kind: 'assign_owner', priority: 1, goal: 'g', suggestion: 's' }, insights: emptyInsights(), recent: [], silenceMs: 3000 })).not.toContain('facilitation step');
    c.stop();
  });
});
