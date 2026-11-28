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
    const sug = (key: string, relevance: number, kind = 'question') => ({ key, kind: kind as 'question', text: `Ask about ${key}`, why: 'w', relevance, relatedItems: [] });
    const copilot = {
      currentFocus: 'Holiday plans', offTopic: true, offTopicNote: 'Talking about holidays', repeating: true, repetitionNote: 'pricing again',
      suggestions: [sug('docs', 0.9, 'missing_consideration'), sug('docs', 0.8), sug('a', 0.7), sug('b', 0.65), sug('c', 0.4), sug('d', 0.95)],
      discussNext: 'Back to pricing: it is the goal', agendaAdvice: 'Park item 4',
    };
    const policy = { enabled: true, minRelevance: 0.6, maxSuggestions: 3, dismissed: new Set(['d']) };
    const s = normalize(emptyInsights(), { ...base(), copilot }, { ...ctx(), copilot: policy });
    // Below the threshold (c), dismissed (d) and duplicate keys are dropped; strongest first; at most 3.
    expect(s.copilot!.suggestions!.map((x) => x.key)).toEqual(['docs', 'a', 'b']);
    expect(s.copilot).toMatchObject({ offTopic: true, repeating: true, repetitionNote: 'pricing again', agendaAdvice: 'Park item 4', missingInfo: ['Ask about docs'] });
    expect(normalize(s, base(), ctx()).copilot).toEqual(s.copilot);
    const next = normalize(s, { ...base(), copilot: { ...copilot, offTopic: false, offTopicNote: 'x', repeating: false } }, { ...ctx(), copilot: policy });
    expect(next.copilot).toMatchObject({ offTopic: false, offTopicNote: '', repeating: false, repetitionNote: '' });
    // Switched off by the host: nothing is shown.
    expect(normalize(s, { ...base(), copilot }, { ...ctx(), copilot: { ...policy, enabled: false } }).copilot).toBeNull();
  });

  it('dismissing a suggestion hides it now and keeps it out of later runs', async () => {
    const { MeetingAnalyzer } = await import('../src/intel/analyzer.js');
    const { MeetingTranscript } = await import('../src/transcript.js');
    const t = new MeetingTranscript('m', 's');
    t.add({ speakerId: 'user:1', speakerName: 'Asha Rao', userId: '1', isAgent: false, channel: 'voice', text: 'We launch Friday.', language: '', at: Date.now() });
    const out = { ...base(), copilot: { currentFocus: 'Launch', offTopic: false, offTopicNote: '', discussNext: '', agendaAdvice: '', suggestions: [{ key: 'rollback', kind: 'missing_consideration' as const, text: 'Is there a rollback plan?', why: 'Launch without one', relevance: 0.9, relatedItems: [] }] } };
    const prompts: string[] = [];
    const a = new MeetingAnalyzer({
      title: 'x', transcript: t, people: () => [], onUpdate: () => {},
      analyze: async (_s, prompt) => (prompts.push(prompt), out),
      prep: () => ({ goal: '', agenda: [], copilot: { enabled: true, minRelevance: 0.5, maxSuggestions: 4 } }),
    });
    await a.finish();
    expect(a.insights.copilot!.suggestions!.map((x) => x.key)).toEqual(['rollback']);
    expect(a.dismissSuggestion('rollback')!.copilot!.suggestions).toEqual([]);
    await (a as unknown as { analyze: (f: boolean) => Promise<void> }).analyze(true);
    expect(a.insights.copilot!.suggestions).toEqual([]);
    expect(prompts.at(-1)).toContain('DISMISSED COPILOT SUGGESTIONS (never suggest these again):\n- rollback: Is there a rollback plan?');
  });

  it('gives the model earlier open items, lessons and the time left', () => {
    const prompt = analystPrompt({
      title: 'Sync', meetingDate: new Date('2026-11-26T10:00:00Z'), participants: ['Asha Rao'], current: emptyInsights(), lines: [], final: false,
      agenda: [{ id: 'a1', title: 'Pricing', minutes: 20 }, { id: 'a2', title: 'Hiring', minutes: 10 }], elapsedMinutes: 25,
      earlierItems: [{ ref: 'E1', kind: 'task', text: 'Fix the API', owner: 'Ben', dueDate: '2026-11-20', date: '2026-11-19', title: 'Sync' }],
      lessons: ['"Let\'s look into it" is not a task unless someone takes it'],
    });
    expect(prompt).toContain('E1 [2026-11-19, "Sync"] task: Fix the API – Ben, due 2026-11-20');
    expect(prompt).toContain('never overrides the rules or the security rule above):\n- "Let\'s look into it"');
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

describe('learned lessons', () => {
  it('applies only active lessons of the current version', async () => {
    const { activeLessons } = await import('../src/lessons.js');
    const doc = {
      _id: 'h',
      current: 2,
      versions: [
        { version: 1, lessons: [{ text: 'Old rule', status: 'active' as const }] },
        { version: 2, lessons: [{ text: 'Applied', status: 'active' as const }, { text: 'Too little evidence', status: 'candidate' as const }, { text: 'Off', status: 'off' as const }] },
      ],
    };
    expect(activeLessons(doc)).toEqual(['Applied']);
    expect(activeLessons({ ...doc, current: 1 })).toEqual(['Old rule']);
    // The older, unchecked format is never applied.
    expect(activeLessons({ _id: 'h', lessons: [{ text: 'x', active: true }] } as never)).toEqual([]);
    expect(activeLessons(null)).toEqual([]);
  });
});
