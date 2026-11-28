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
    expect(chips).toEqual(['Needs confirmation', 'Confirmed']);
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

  it("shows what carried over from last meeting and flags a reversed decision", async () => {
    const f = await render({
      insights: {
        ...notes,
        carryover: {
          fromTitle: "Billing sync", fromDate: "2026-11-19",
          decisions: [{ statement: "Which queue to use", options: ["SQS", "Kafka"] }],
          tasks: [{ task: "Migration plan", owner: "Ravi", dueDate: "2026-11-21", overdue: true }],
        },
        decisions: [{
          ...notes.decisions[0]!, id: "d3", statement: "Move billing to MongoDB", status: "proposed",
          contradicts: { ref: "P1", statement: "Use PostgreSQL for billing", date: "2026-11-12", title: "Kickoff" },
        }],
      },
    });
    const el = f.nativeElement as HTMLElement;
    const carry = el.querySelector(".carry")!.textContent!.replace(/\s+/g, " ");
    expect(carry).toContain("From last meeting");
    expect(carry).toContain("Migration plan – Ravi, due 2026-11-21 · overdue");
    expect(carry).toContain("Undecided: Which queue to use (SQS vs Kafka)");
    expect(el.querySelector(".conflict")!.textContent!.replace(/\s+/g, " ").trim())
      .toBe("Goes against the decision of 2026-11-12 (“Kickoff”): Use PostgreSQL for billing");
    // nothing extra when there is no carryover or conflict
    const plain = (await render({ insights: notes })).nativeElement as HTMLElement;
    expect(plain.querySelector(".carry")).toBeNull();
    expect(plain.querySelector(".conflict")).toBeNull();
  });

  it('shows the live copilot only in the meeting, plus risks, assumptions and key points', async () => {
    const live: Insights = {
      ...notes,
      copilot: {
        currentFocus: 'Holiday plans', offTopic: true, offTopicNote: 'drifted to holidays', missingInfo: ['Owner for the schema'],
        suggestedQuestions: ['Who drafts the schema?'], discussNext: 'Back to the database choice', agendaAdvice: '', updatedAt: '',
      },
      risks: [{
        id: 'r1', kind: 'conflict', description: 'Asha commits to Friday but the API arrives Monday', involves: ['Asha', 'Ben'], relatedItems: [],
        earlier: null, severity: 'high', suggestedQuestion: 'Can it ship without the API?', status: 'open', evidence: [],
      }],
      assumptions: [{ id: 's1', statement: 'The client accepts a delay', madeBy: 'Ben', status: 'unverified', evidence: [] }],
      keyPoints: [{ id: 'k1', point: 'Churn rose 4%', importance: 'high', evidence: [] }],
    };
    const inRoom = (await render({ insights: live, live: true })).nativeElement as HTMLElement;
    expect(inRoom.querySelector('.copilot')?.textContent).toContain('Off topic: drifted to holidays');
    expect(inRoom.querySelector('.copilot')?.textContent).toContain('Who drafts the schema?');
    expect(inRoom.querySelector('.risk')?.textContent).toContain('Can it ship without the API?');
    expect(inRoom.textContent).toContain('The client accepts a delay');
    expect(inRoom.textContent).toContain('Churn rose 4%');
    const page = (await render({ insights: live })).nativeElement as HTMLElement;
    expect(page.querySelector('.copilot')).toBeNull();
    expect(page.querySelector('.risk')).not.toBeNull();
  });
});
