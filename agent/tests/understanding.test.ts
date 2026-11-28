import { describe, expect, it } from 'vitest';
import { normalize, type Person } from '../src/intel/normalize.js';
import { renderNotes } from '../src/intel/render.js';
import { emptyInsights, type ModelOutput } from '../src/intel/schema.js';

const people: Person[] = [{ identity: 'user:1', name: 'Asha Rao', userId: '1' }, { identity: 'user:2', name: 'Ben Ortiz', userId: '2' }];
const T = (m: number) => Date.UTC(2026, 10, 26, 10, m);
const lineInfo = new Map([
  [1, { at: T(1), speaker: 'Asha Rao' }],
  [2, { at: T(2), speaker: 'Ben Ortiz' }],
  [3, { at: T(5), speaker: 'Asha Rao' }],
  [4, { at: T(9), speaker: 'Ben Ortiz' }],
]);
const ctx = (minute: number) => ({ validLines: new Set([1, 2, 3, 4]), people, analyzedThrough: 4, now: new Date(T(minute)), lineInfo });
const base = (): ModelOutput => ({ summary: '', topics: [], decisions: [], actionItems: [], openQuestions: [] });
const decision = (o: Partial<ModelOutput['decisions'][number]>): ModelOutput['decisions'][number] => ({
  id: '', topic: 'Launch', statement: 'Launch on Monday', status: 'agreed', options: [], proposedBy: ['Asha Rao'], supporters: [], objectors: [],
  confirmationNeeded: '', contradicts: '', evidence: [1, 2], ...o,
});

describe('decisions are updated, not duplicated', () => {
  it('keeps the history and flags a reversal when an agreed decision changes', () => {
    const s1 = normalize(emptyInsights(), { ...base(), decisions: [decision({ confidence: 0.9 })] }, ctx(3));
    expect(s1.decisions[0]).toMatchObject({ id: 'd1', finality: 'final', confidence: 0.9, reversed: false, trace: { speakers: ['Asha Rao', 'Ben Ortiz'] } });
    expect(s1.decisions[0]!.trace!.firstAt).toBe(new Date(T(1)).toISOString());

    const s2 = normalize(s1, { ...base(), decisions: [decision({ id: 'd1', status: 'rejected', statement: 'Launch on Monday', reversed: true, evidence: [4] })] }, ctx(10));
    expect(s2.decisions).toHaveLength(1);
    expect(s2.decisions[0]).toMatchObject({ status: 'rejected', reversed: true, history: [{ status: 'agreed', statement: 'Launch on Monday' }] });
    expect(s2.decisions[0]!.trace!.lastAt).toBe(new Date(T(9)).toISOString());
  });

  it('folds a duplicate into the decision it revises', () => {
    const s1 = normalize(emptyInsights(), { ...base(), decisions: [decision({})] }, ctx(3));
    const s2 = normalize(s1, { ...base(), decisions: [decision({ id: '', statement: 'Launch on Monday if legal signs off', finality: 'conditional', condition: 'legal signs off', revises: 'd1', evidence: [3] })] }, ctx(6));
    expect(s2.decisions).toHaveLength(1);
    expect(s2.decisions[0]).toMatchObject({ id: 'd1', finality: 'conditional', condition: 'legal signs off', evidence: [1, 2, 3] });
    expect(s2.decisions[0]!.history).toHaveLength(1);
    expect(renderNotes(s2)).toContain('[AGREED, CONDITIONAL] Launch on Monday if legal signs off (only if legal signs off)');
  });

  it('marks the old decision superseded when a different one replaces it', () => {
    const s1 = normalize(emptyInsights(), { ...base(), decisions: [decision({}), decision({ statement: 'Hire a contractor', topic: 'Staffing', evidence: [2] })] }, ctx(3));
    const s2 = normalize(s1, { ...base(), decisions: [decision({ id: 'd2', statement: 'Launch on Thursday', topic: 'Launch', revises: 'd1', evidence: [4] })] }, ctx(10));
    const old = s2.decisions.find((d) => d.id === 'd1')!;
    expect(old).toMatchObject({ status: 'superseded', supersededBy: 'd2', reversed: true });
    expect(renderNotes(s2)).not.toContain('Launch on Monday');
  });
});

describe('commitments, facts and corrections', () => {
  it('records tentative commitments, fact/opinion/idea, answers and changed positions', () => {
    const s = normalize(emptyInsights(), {
      ...base(),
      actionItems: [{ id: '', task: 'Look at pricing', owner: 'Ben', deadline: '', dueDate: '', status: 'open', commitment: 'tentative', confidence: 1.7, evidence: [2] }],
      keyPoints: [
        { id: '', point: 'Churn is 4%', importance: 'high', kind: 'fact', evidence: [1] },
        { id: '', point: 'We could try a freemium tier', importance: 'normal', kind: 'idea', evidence: [3] },
      ],
      openQuestions: [{ id: '', question: 'Who owns QA?', askedBy: 'Asha', status: 'answered', answer: 'Ben', evidence: [3, 4] }],
      statementChanges: [{ id: '', person: 'Asha', kind: 'corrected', topic: 'user count', before: '200 users', after: '20 users', relatedItems: ['t1', 'zz'], evidence: [3] }],
    }, ctx(10));
    expect(s.actionItems[0]).toMatchObject({ owner: 'Ben Ortiz', commitment: 'tentative', confidence: 1 });
    expect(s.keyPoints!.map((k) => k.kind)).toEqual(['fact', 'idea']);
    expect(s.openQuestions[0]).toMatchObject({ status: 'answered', answer: 'Ben', answeredAt: new Date(T(10)).toISOString() });
    expect(s.statementChanges![0]).toMatchObject({ id: 'c1', person: 'Asha Rao', kind: 'corrected', after: '20 users', relatedItems: ['t1'] });
    const notes = renderNotes(s);
    expect(notes).toContain('(tentative)');
    expect(notes).toContain('Asha Rao corrected user count: "200 users" → "20 users"');
  });
});
