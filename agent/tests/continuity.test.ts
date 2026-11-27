import { describe, expect, it, vi } from 'vitest';
import { buildContinuity, renderCarryover } from '../src/carryover.js';
import { MeetingAnalyzer } from '../src/intel/analyzer.js';
import { normalize } from '../src/intel/normalize.js';
import { analystPrompt } from '../src/intel/prompt.js';
import { emptyInsights, type AgendaProgress, type Decision, type Insights, type ModelOutput } from '../src/intel/schema.js';
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

