import { describe, expect, it } from 'vitest';
import { normalize } from '../src/intel/normalize.js';
import { analystPrompt } from '../src/intel/prompt.js';
import { renderNotes } from '../src/intel/render.js';
import { emptyInsights, type ModelOutput } from '../src/intel/schema.js';
import { renderPrep } from '../src/prep.js';
import type { Utterance } from '../src/transcript.js';

const T0 = Date.UTC(2026, 10, 27, 10, 0, 0);
const plan = [
  { id: 'a1', title: 'Database choice', minutes: 10 },
  { id: 'a2', title: 'Owners', minutes: 5 },
  { id: 'a3', title: 'Budget', minutes: null },
];
const goal = 'Decide the database and assign migration owners';
const base = (): ModelOutput => ({ summary: '', topics: [], decisions: [], actionItems: [], openQuestions: [] });
const ctx = (ms: number) => ({ validLines: new Set<number>(), people: [], analyzedThrough: 1, now: new Date(T0 + ms), goal, agendaPlan: plan });

function lines(n: number, from = T0): Utterance[] {
  return Array.from({ length: n }, (_, i) => ({
    id: i + 1, speakerId: 'user:a', speakerName: 'A', userId: null, isAgent: false, channel: 'voice' as const,
    text: `line ${i}`, language: 'en', at: from + i * 1000,
  }));
}

describe('goal and agenda progress', () => {
  it('tracks agenda items by the host\'s ids, with start/finish times, ignoring unknown ids', () => {
    const s1 = normalize(emptyInsights(), {
      ...base(),
      progress: {
        goalStatus: 'on_track', goalReason: 'discussing databases',
        agenda: [{ id: 'a1', status: 'in_progress', note: '' }, { id: 'zzz', status: 'done', note: 'bogus' }],
      },
    }, ctx(60_000));
    expect(s1.goal).toMatchObject({ text: goal, status: 'on_track' });
    expect(s1.agenda.map((a) => [a.id, a.status])).toEqual([['a1', 'in_progress'], ['a2', 'not_started'], ['a3', 'not_started']]);
    expect(s1.agenda[0]!.startedAt).toBe(new Date(T0 + 60_000).toISOString());

    const s2 = normalize(s1, {
      ...base(),
      progress: { goalStatus: 'on_track', goalReason: '', agenda: [{ id: 'a1', status: 'done', note: 'PostgreSQL agreed' }, { id: 'a2', status: 'in_progress', note: '' }] },
    }, ctx(9 * 60_000));
    expect(s2.agenda[0]).toMatchObject({ status: 'done', note: 'PostgreSQL agreed', startedAt: s1.agenda[0]!.startedAt });
    expect(s2.agenda[0]!.doneAt).toBe(new Date(T0 + 9 * 60_000).toISOString());
    expect(s2.goal!.since).toBe(s1.goal!.since); // still on track since the start

    // A noisy run never moves a finished item back to "not started".
    const s3 = normalize(s2, { ...base(), progress: { goalStatus: 'drifting', goalReason: 'weekend plans', agenda: [{ id: 'a1', status: 'not_started', note: '' }] } }, ctx(10 * 60_000));
    expect(s3.agenda[0]!.status).toBe('done');
    expect(s3.goal).toMatchObject({ status: 'drifting', reason: 'weekend plans', since: new Date(T0 + 10 * 60_000).toISOString() });
  });

  it('has no goal/agenda progress when the host prepared none', () => {
    const s = normalize(emptyInsights(), base(), { ...ctx(0), goal: '', agendaPlan: [] });
    expect(s.goal).toBeNull();
    expect(s.agenda).toEqual([]);
  });

  it('puts the goal, agenda statuses and elapsed time in the analyst prompt and voice notes', () => {
    const cur = normalize(emptyInsights(), { ...base(), progress: { goalStatus: 'on_track', goalReason: '', agenda: [{ id: 'a1', status: 'in_progress', note: '' }] } }, ctx(0));
    const p = analystPrompt({ title: 'Sync', meetingDate: new Date(T0), participants: ['A'], current: cur, lines: lines(1), final: false, goal, agenda: plan, elapsedMinutes: 7 });
    expect(p).toContain(`MEETING GOAL: ${goal}`);
    expect(p).toContain('a1: Database choice [10 min] – in_progress');
    expect(p).toContain('a3: Budget – not_started');
    expect(p).toContain('Minutes since the meeting started: 7');
    expect(renderNotes(cur)).toContain('- Database choice: in progress');
  });
});

describe('preparation in the AI instructions', () => {
  it('lists the goal, agenda with times and document excerpts', () => {
    const text = renderPrep({
      goal,
      agenda: plan,
      documents: [{ id: 'd1', filename: 'spec.pdf', preview: 'Retention is 90 days.' }],
      replyMode: 'named',
    });
    expect(text).toContain(`MEETING GOAL: ${goal}`);
    expect(text).toContain('1. Database choice (10 min)\n2. Owners (5 min)\n3. Budget');
    expect(text).toContain('--- spec.pdf ---\nRetention is 90 days.');
    expect(renderPrep({ goal: '', agenda: [], documents: [], replyMode: 'named' })).toBe('');
  });
});
