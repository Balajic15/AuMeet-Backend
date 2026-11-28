import { describe, expect, it } from 'vitest';
import { buildContinuity } from '../src/carryover.js';
import { normalize, type Person } from '../src/intel/normalize.js';
import { analystPrompt } from '../src/intel/prompt.js';
import { renderNotes } from '../src/intel/render.js';
import { emptyInsights, type ModelOutput } from '../src/intel/schema.js';

const people: Person[] = [
  { identity: 'user:1', name: 'Asha Rao', userId: '1' },
  { identity: 'user:2', name: 'Ben Ortiz', userId: '2' },
];
const base = (): ModelOutput => ({ summary: '', topics: [], decisions: [], actionItems: [], openQuestions: [] });
const ctx = (extra = {}) => ({ validLines: new Set([1, 2, 3, 4]), people, analyzedThrough: 4, now: new Date('2026-11-26T10:00:00Z'), ...extra });

const friday = {
  id: '', task: 'Ship the billing page', owner: 'Asha Rao', deadline: 'by Friday', dueDate: '2026-11-27', status: 'open' as const, evidence: [1],
};
const conflict = {
  id: '', kind: 'conflict' as const,
  description: 'Asha commits to Friday but the API Ben needs only arrives Monday',
  involves: ['Asha Rao', 'Ben Ortiz'], relatedItems: ['t1', 'x9'], earlierRef: 'E1', severity: 'high' as const,
  suggestedQuestion: 'Can the billing page ship Friday without the new API?', status: 'open' as const, evidence: [1, 2, 77],
};

describe('real-time intelligence', () => {
  it('records risks with links to real items, earlier blockers and a clarifying question', () => {
    const earlierItems = [{ ref: 'E1', kind: 'risk' as const, text: 'Billing API keeps slipping', owner: null, dueDate: null, date: '2026-11-19', title: 'Sync' }];
    const s = normalize(emptyInsights(), { ...base(), actionItems: [friday], risks: [conflict] }, ctx({ earlierItems }));
    expect(s.risks).toHaveLength(1);
    expect(s.risks![0]).toMatchObject({ id: 'r1', relatedItems: ['t1'], evidence: [1, 2], earlier: { ref: 'E1' }, suggestedQuestion: conflict.suggestedQuestion });

    // Resolved: the question goes, the item stays; the model forgetting it later never drops it.
    const resolved = normalize(s, { ...base(), risks: [{ ...conflict, id: 'r1', status: 'resolved', earlierRef: '' }] }, ctx({ earlierItems }));
    expect(resolved.risks![0]).toMatchObject({ status: 'resolved', suggestedQuestion: null, earlier: { ref: 'E1' } });
    expect(normalize(resolved, base(), ctx()).risks).toHaveLength(1);
  });

  it('keeps assumptions apart from decisions and tracks when a decision was settled', () => {
    const s = normalize(
      emptyInsights(),
      {
        ...base(),
        assumptions: [{ id: '', statement: 'The client accepts a two-week delay', madeBy: 'Ben Ortiz', status: 'unverified', evidence: [3] }],
        keyPoints: [{ id: '', point: 'Churn rose 4% last month', importance: 'high', evidence: [2] }],
        decisions: [{
          id: '', topic: 'DB', statement: 'Use PostgreSQL', status: 'agreed', options: [], proposedBy: [], supporters: [], objectors: [],
          confirmationNeeded: '', contradicts: '', evidence: [4],
        }],
      },
      ctx(),
    );
    expect(s.assumptions![0]).toMatchObject({ id: 's1', status: 'unverified', madeBy: 'Ben Ortiz' });
    expect(s.keyPoints![0]).toMatchObject({ id: 'k1', importance: 'high' });
    expect(s.decisions[0]!.settledAt).toBe('2026-11-26T10:00:00.000Z');
    const notes = renderNotes(s);
    expect(notes).toContain('Unverified assumptions');
    expect(notes).toContain('Churn rose 4%');
  });

  it('replaces the copilot view on each run and keeps it when a run has none', () => {
    const copilot = {
      currentFocus: 'Holiday plans', offTopic: true, offTopicNote: 'Talking about holidays', missingInfo: ['Owner for the docs', 'Owner for the docs'],
      suggestedQuestions: ['Who owns the docs?', 'a', 'b', 'c'], discussNext: 'Back to pricing: it is the goal', agendaAdvice: 'Park item 4',
    };
    const s = normalize(emptyInsights(), { ...base(), copilot }, ctx());
    expect(s.copilot).toMatchObject({ offTopic: true, missingInfo: ['Owner for the docs'], agendaAdvice: 'Park item 4' });
    expect(s.copilot!.suggestedQuestions).toHaveLength(3);
    expect(normalize(s, base(), ctx()).copilot).toEqual(s.copilot);
    const next = normalize(s, { ...base(), copilot: { ...copilot, offTopic: false, offTopicNote: 'x' } }, ctx());
    expect(next.copilot).toMatchObject({ offTopic: false, offTopicNote: '' });
  });

  it('gives the model earlier open items, lessons and the time left', () => {
    const prompt = analystPrompt({
      title: 'Sync', meetingDate: new Date('2026-11-26T10:00:00Z'), participants: ['Asha Rao'], current: emptyInsights(), lines: [], final: false,
      agenda: [{ id: 'a1', title: 'Pricing', minutes: 20 }, { id: 'a2', title: 'Hiring', minutes: 10 }], elapsedMinutes: 25,
      earlierItems: [{ ref: 'E1', kind: 'task', text: 'Fix the API', owner: 'Ben', dueDate: '2026-11-20', date: '2026-11-19', title: 'Sync' }],
      lessons: ['"Let\'s look into it" is not a task unless someone takes it'],
    });
    expect(prompt).toContain('E1 [2026-11-19, "Sync"] task: Fix the API – Ben, due 2026-11-20');
    expect(prompt).toContain('LESSONS FROM CORRECTIONS:\n- "Let\'s look into it"');
    expect(prompt).toContain('planned total 30 min, 5 min left');
  });

  it('collects open tasks and risks from earlier sessions as E-refs', () => {
    const c = buildContinuity(
      [
        {
          meetingCode: 'm', sessionId: 's1', title: 'Sync', startedAt: new Date('2026-11-19T10:00:00Z'),
          insights: {
            actionItems: [{ task: 'Fix the API', owner: 'Ben', dueDate: '2026-11-20', status: 'open' }, { task: 'Done thing', owner: null, dueDate: null, status: 'done' }],
            risks: [{ description: 'Vendor contract not signed', status: 'open', involves: ['Asha'] }],
          },
        },
      ],
      new Date('2026-11-26T10:00:00Z'),
    );
    expect(c.earlierItems.map((e) => `${e.ref} ${e.kind} ${e.text}`)).toEqual(['E1 risk Vendor contract not signed', 'E2 task Fix the API']);
  });
});
