import { TestBed } from '@angular/core/testing';
import { describe, expect, it } from 'vitest';
import type { Insights } from '../core/insights';
import { InsightsView } from './insights-view';

const notes: Insights = {
  summary: 'We compared databases.',
  topics: [{ id: 'p1', title: 'Database', status: 'active' }],
  decisions: [
    { id: 'd2', topic: 'Infra', statement: 'Ship weekly', status: 'agreed', options: [], proposedBy: [], supporters: ['Ben'], objectors: [], confirmationNeeded: null, evidence: [] },
    {
      id: 'd1', topic: 'Database', statement: 'Which database to use', status: 'disputed', options: ['MongoDB', 'PostgreSQL'],
      proposedBy: ['Asha'], supporters: [], objectors: [], confirmationNeeded: 'Can we confirm which database?', evidence: [1],
    },
  ],
  actionItems: [
    { id: 't1', task: 'Draft schema', owner: null, ownerUserId: null, deadline: 'by Friday', dueDate: null, status: 'open', evidence: [] },
  ],
  openQuestions: [{ id: 'q1', question: 'Budget?', askedBy: 'Ben', status: 'open', evidence: [] }],
  analyzedThrough: 3,
  updatedAt: '2026-11-26T10:00:00Z',
};

async function render(inputs: Record<string, unknown>) {
  const fixture = TestBed.createComponent(InsightsView);
  for (const [k, v] of Object.entries(inputs)) fixture.componentRef.setInput(k, v);
  await fixture.whenStable();
  fixture.detectChanges();
  return fixture;
}

describe('InsightsView', () => {
  it('lists decisions needing confirmation first, with options and the question to ask', async () => {
    const f = await render({ insights: notes });
    const el = f.nativeElement as HTMLElement;
    const chips = [...el.querySelectorAll('.chip')].map((c) => c.textContent?.trim());
    expect(chips).toEqual(['Needs confirmation', 'Agreed']);
    expect(el.textContent).toContain('MongoDB');
    expect(el.querySelector('.ask')?.textContent).toContain('Can we confirm which database?');
    expect(el.querySelector('.unassigned')?.textContent?.trim()).toBe('No owner');
    expect(el.textContent).toContain('Budget?');
  });

  it('shows sources from the transcript and only offers editing when allowed', async () => {
    const f = await render({
      insights: notes,
      lines: [{ seq: 1, speakerName: 'Asha', isAgent: false, channel: 'voice', text: "Let's use MongoDB", at: '' }],
    });
    const el = f.nativeElement as HTMLElement;
    expect(el.querySelector('[aria-label="Edit decision"]')).toBeNull();
    (el.querySelector('.src-btn') as HTMLButtonElement).click();
    f.detectChanges();
    expect(el.querySelector('.sources')?.textContent).toContain("Let's use MongoDB");

    f.componentRef.setInput('editable', true);
    const deleted: unknown[] = [];
    f.componentInstance.deleteItem.subscribe((e) => deleted.push(e));
    f.detectChanges();
    (el.querySelector('[aria-label="Delete task"]') as HTMLButtonElement).click();
    expect(deleted).toEqual([{ kind: 'tasks', id: 't1' }]);
  });
});

describe('InsightsView – goal and agenda', () => {
  it('shows the goal status and agenda progress', async () => {
    const f = await render({
      insights: {
        ...notes,
        goal: { text: 'Decide the database', status: 'drifting', reason: 'talking about the offsite', since: '' },
        agenda: [
          { id: 'a1', title: 'Database choice', minutes: 10, status: 'done', note: 'PostgreSQL', startedAt: '2026-11-27T10:00:00Z', doneAt: '2026-11-27T10:08:00Z' },
          { id: 'a2', title: 'Owners', minutes: 5, status: 'not_started', note: '', startedAt: null, doneAt: null },
        ],
      },
    });
    const el = f.nativeElement as HTMLElement;
    expect(el.querySelector('.goal-text')?.textContent).toBe('Decide the database');
    expect(el.querySelector('.goal-status')?.textContent).toContain('Drifting – talking about the offsite');
    expect(el.textContent).toContain('1/2');
    expect(el.querySelector('.a-done .a-meta')?.textContent?.replace(/\s+/g, ' ').trim()).toBe('Done · 8/10 min · PostgreSQL');
    expect(el.querySelector('.a-not_started .a-meta')?.textContent?.replace(/\s+/g, ' ').trim()).toBe('Not started · 5 min');
  });
});
