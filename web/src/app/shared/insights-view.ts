import { ChangeDetectionStrategy, Component, computed, input, output, signal } from '@angular/core';
import type { ActionItem, Decision, DecisionStatus, Insights, TranscriptLine } from '../core/insights';
import { Icon } from './icon';

const STATUS_LABEL: Record<DecisionStatus, string> = {
  disputed: 'Needs confirmation',
  proposed: 'Proposed',
  agreed: 'Agreed',
  rejected: 'Dropped',
};

/** Order: things the team must act on first. */
const STATUS_ORDER: DecisionStatus[] = ['disputed', 'proposed', 'agreed', 'rejected'];

/**
 * Renders AI meeting notes. Used live in the room's side panel (compact) and on the
 * meeting notes page (with transcript sources).
 */
@Component({
  selector: 'app-insights-view',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [Icon],
  template: `
    @let i = insights();
    @if (i.goal; as g) {
      <section class="block goal" [class]="'block goal g-' + g.status">
        <h3>Goal</h3>
        <p class="goal-text">{{ g.text }}</p>
        <p class="goal-status"><span class="dot"></span> {{ goalLabel(g.status) }}@if (g.reason) { – {{ g.reason }} }</p>
      </section>
    }
    @if (i.agenda?.length) {
      <section class="block">
        <h3>Agenda <span class="n">{{ doneCount(i) }}/{{ i.agenda!.length }}</span></h3>
        <ol class="agenda">
          @for (a of i.agenda; track a.id) {
            <li [class]="'a-' + a.status">
              <span class="a-mark" [attr.aria-label]="agendaLabel(a.status)">{{ agendaMark(a.status) }}</span>
              <div class="a-body">
                <div class="a-title">{{ a.title }}</div>
                <div class="a-meta">
                  {{ agendaLabel(a.status) }}@if (a.minutes) { · {{ used(a) }}{{ a.minutes }} min }@if (a.note) { · {{ a.note }} }
                </div>
              </div>
            </li>
          }
        </ol>
      </section>
    }
    @if (i.summary) {
      <section class="block">
        <h3>Summary</h3>
        <p class="summary">{{ i.summary }}</p>
      </section>
    }

    <section class="block">
      <h3>Decisions <span class="n">{{ decisions().length }}</span></h3>
      @if (decisions().length === 0) {
        <p class="none">No decisions yet.</p>
      }
      @for (d of decisions(); track d.id) {
        <article class="card" [class]="'card st-' + d.status">
          <div class="card-head">
            <span class="chip" [class]="'chip st-' + d.status">{{ label(d.status) }}</span>
            @if (d.topic) { <span class="topic">{{ d.topic }}</span> }
            @if (editable()) {
              <span class="edit-actions">
                <button type="button" class="icon-btn" title="Edit" aria-label="Edit decision" (click)="editDecision.emit(d)">
                  <app-icon name="edit" [size]="15" />
                </button>
                <button type="button" class="icon-btn danger" title="Delete" aria-label="Delete decision"
                        (click)="deleteItem.emit({ kind: 'decisions', id: d.id })">
                  <app-icon name="trash" [size]="15" />
                </button>
              </span>
            }
          </div>
          <p class="statement">{{ d.statement }}</p>
          @if (d.status === 'disputed' && d.options.length) {
            <div class="options">
              @for (o of d.options; track o) { <span class="opt">{{ o }}</span> }
            </div>
          }
          @if (d.confirmationNeeded) {
            <p class="ask"><app-icon name="sparkles" [size]="14" /> {{ d.confirmationNeeded }}</p>
          }
          <p class="who">{{ people(d) }}</p>
          @if (sourcesFor(d.evidence).length) {
            <button type="button" class="src-btn" (click)="toggle(d.id)">
              {{ open() === d.id ? 'Hide' : 'Show' }} sources ({{ sourcesFor(d.evidence).length }})
            </button>
            @if (open() === d.id) {
              <ul class="sources">
                @for (l of sourcesFor(d.evidence); track l.seq) {
                  <li><strong>{{ l.speakerName }}:</strong> “{{ l.text }}”</li>
                }
              </ul>
            }
          }
        </article>
      }
    </section>

    <section class="block">
      <h3>Action items <span class="n">{{ i.actionItems.length }}</span></h3>
      @if (i.actionItems.length === 0) {
        <p class="none">No tasks yet.</p>
      } @else {
        <ul class="tasks">
          @for (a of i.actionItems; track a.id) {
            <li [class.done]="a.status === 'done'">
              <span class="tick">
                @if (a.status === 'done') { <app-icon name="check" [size]="14" /> }
              </span>
              <div class="task-body">
                <div class="task">{{ a.task }}</div>
                @if (editable()) {
                  <span class="edit-actions task-actions">
                    <button type="button" class="icon-btn" title="Edit" aria-label="Edit task" (click)="editTask.emit(a)">
                      <app-icon name="edit" [size]="15" />
                    </button>
                    <button type="button" class="icon-btn danger" title="Delete" aria-label="Delete task"
                            (click)="deleteItem.emit({ kind: 'tasks', id: a.id })">
                      <app-icon name="trash" [size]="15" />
                    </button>
                  </span>
                }
                <div class="task-meta">
                  <span [class.unassigned]="!a.owner">{{ a.owner ?? 'No owner' }}</span>
                  @if (a.deadline || a.dueDate) {
                    <span class="sep">·</span>
                    <span><app-icon name="calendar" [size]="12" /> {{ due(a.dueDate, a.deadline) }}</span>
                  }
                </div>
              </div>
            </li>
          }
        </ul>
      }
    </section>

    @if (openQuestions().length) {
      <section class="block">
        <h3>Open questions <span class="n">{{ openQuestions().length }}</span></h3>
        <ul class="questions">
          @for (q of openQuestions(); track q.id) {
            <li>
              {{ q.question }} @if (q.askedBy) { <span class="asked">— {{ q.askedBy }}</span> }
              @if (editable()) {
                <button type="button" class="icon-btn danger inline" title="Delete" aria-label="Delete question"
                        (click)="deleteItem.emit({ kind: 'questions', id: q.id })">
                  <app-icon name="trash" [size]="14" />
                </button>
              }
            </li>
          }
        </ul>
      </section>
    }

    @if (!compact() && i.topics.length) {
      <section class="block">
        <h3>Topics</h3>
        <div class="topics">
          @for (t of i.topics; track t.id) { <span class="opt">{{ t.title }}</span> }
        </div>
      </section>
    }
  `,
  styles: `
    :host { display: block; }
    .block { margin-bottom: 26px; }
    h3 {
      display: flex; align-items: center; gap: 8px; margin: 0 0 12px;
      font-size: 13px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.05em; color: var(--text-muted);
    }
    .n { padding: 0 7px; border-radius: 99px; background: #2a2a2a; color: var(--text); font-size: 11.5px; letter-spacing: 0; }
    .summary { margin: 0; line-height: 1.6; font-size: 15px; }
    .goal { padding: 12px 14px; background: var(--surface-sunken); border-left: 3px solid #555; }
    .goal.g-on_track, .goal.g-achieved { border-left-color: var(--brand); }
    .goal.g-drifting { border-left-color: #ffb020; }
    .goal.g-off_track { border-left-color: var(--danger); }
    .goal-text { margin: 0; font-size: 15px; font-weight: 500; line-height: 1.45; }
    .goal-status { display: flex; align-items: center; gap: 6px; margin: 8px 0 0; color: var(--text-muted); font-size: 13px; }
    .goal-status .dot { width: 8px; height: 8px; border-radius: 50%; background: #777; flex: none; }
    .g-on_track .dot, .g-achieved .dot { background: var(--brand); }
    .g-drifting .dot { background: #ffb020; }
    .g-off_track .dot { background: var(--danger); }
    .agenda { list-style: none; margin: 0; padding: 0; }
    .agenda li { display: flex; gap: 10px; padding: 8px 0; border-bottom: 1px solid #222; }
    .a-mark { flex: none; width: 20px; height: 20px; display: grid; place-items: center; border-radius: 50%; border: 1.5px solid #555; font-size: 11px; }
    .a-in_progress .a-mark { border-color: var(--brand); color: var(--brand); }
    .a-done .a-mark { background: var(--brand); border-color: var(--brand); color: var(--brand-ink); }
    .a-skipped .a-title { text-decoration: line-through; color: var(--text-muted); }
    .a-title { font-size: 14.5px; }
    .a-meta { margin-top: 2px; color: var(--text-muted); font-size: 12.5px; }
    .none { margin: 0; color: var(--text-placeholder); font-size: 14px; }

    .card {
      padding: 14px 16px; margin-bottom: 10px; background: var(--surface-sunken);
      border: 1px solid #262626; border-left: 3px solid #444;
    }
    .card.st-disputed { border-left-color: #ffb020; }
    .card.st-agreed { border-left-color: var(--brand); }
    .card.st-rejected { opacity: 0.6; }
    .card-head { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
    .chip { font-size: 11.5px; font-weight: 600; padding: 2px 8px; border: 1px solid currentColor; }
    .chip.st-disputed { color: #ffb020; }
    .chip.st-proposed { color: #9db4ff; }
    .chip.st-agreed { color: var(--brand); }
    .chip.st-rejected { color: var(--text-muted); }
    .topic { color: var(--text-muted); font-size: 12.5px; }
    .statement { margin: 10px 0 0; font-size: 15px; font-weight: 500; line-height: 1.45; }
    .options, .topics { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 10px; }
    .opt { padding: 3px 9px; border: 1px solid var(--border); font-size: 13px; }
    .ask {
      display: flex; gap: 8px; align-items: flex-start; margin: 12px 0 0; padding: 8px 10px;
      background: rgba(255, 176, 32, 0.08); color: #ffcf73; font-size: 13.5px; line-height: 1.45;
    }
    .who { margin: 10px 0 0; color: var(--text-muted); font-size: 12.5px; }
    .who:empty { display: none; }
    .src-btn { margin-top: 8px; padding: 0; background: none; border: none; color: var(--link); font-size: 13px; cursor: pointer; }
    .sources { margin: 8px 0 0; padding: 0 0 0 12px; border-left: 2px solid #333; list-style: none; font-size: 13.5px; color: #cfcfcf; }
    .sources li { margin: 6px 0; line-height: 1.45; }

    .tasks, .questions { list-style: none; margin: 0; padding: 0; }
    .tasks li { display: flex; gap: 12px; padding: 10px 0; border-bottom: 1px solid #222; }
    .tasks li:last-child { border-bottom: none; }
    .tick {
      flex: none; width: 18px; height: 18px; margin-top: 2px; border: 1.5px solid #555; border-radius: 3px;
      display: grid; place-items: center; color: var(--brand-ink);
    }
    li.done .tick { background: var(--brand); border-color: var(--brand); }
    li.done .task { text-decoration: line-through; color: var(--text-muted); }
    .task { font-size: 15px; line-height: 1.4; }
    .task-meta { display: flex; align-items: center; gap: 6px; margin-top: 4px; color: var(--text-muted); font-size: 13px; }
    .task-meta app-icon { vertical-align: -1px; }
    .unassigned { color: #ffb020; }
    .questions li { padding: 8px 0; font-size: 14.5px; line-height: 1.45; border-bottom: 1px solid #222; }
    .asked { color: var(--text-muted); font-size: 13px; }
    .edit-actions { margin-left: auto; display: inline-flex; gap: 2px; }
    .edit-actions .icon-btn, .icon-btn.inline { width: 28px; height: 28px; }
    .icon-btn.inline { vertical-align: middle; margin-left: 4px; }
    .icon-btn.danger:hover { color: var(--danger); }
    .task-body { position: relative; flex: 1; padding-right: 64px; }
    .task-actions { position: absolute; top: -4px; right: 0; }
  `,
})
export class InsightsView {
  readonly insights = input.required<Insights>();
  /** Transcript lines for "Show sources" (only on the notes page). */
  readonly lines = input<TranscriptLine[]>([]);
  readonly compact = input(false);
  /** Show edit/delete controls (notes page, after the meeting ended). */
  readonly editable = input(false);
  readonly editDecision = output<Decision>();
  readonly editTask = output<ActionItem>();
  readonly deleteItem = output<{ kind: 'decisions' | 'tasks' | 'questions'; id: string }>();

  protected readonly open = signal<string | null>(null);

  protected readonly decisions = computed(() =>
    [...this.insights().decisions].sort((a, b) => STATUS_ORDER.indexOf(a.status) - STATUS_ORDER.indexOf(b.status)),
  );
  protected readonly openQuestions = computed(() => this.insights().openQuestions.filter((q) => q.status === 'open'));
  private readonly bySeq = computed(() => new Map(this.lines().map((l) => [l.seq, l])));

  protected goalLabel(s: string): string {
    return { on_track: 'On track', drifting: 'Drifting', off_track: 'Off track', achieved: 'Achieved', no_goal: '' }[s] ?? s;
  }

  protected agendaLabel(s: string): string {
    return { not_started: 'Not started', in_progress: 'In progress', done: 'Done', skipped: 'Skipped' }[s] ?? s;
  }

  protected agendaMark(s: string): string {
    return { not_started: '', in_progress: '•', done: '✓', skipped: '–' }[s] ?? '';
  }

  protected doneCount(i: Insights): number {
    return (i.agenda ?? []).filter((a) => a.status === 'done').length;
  }

  /** "6/10 min" while running or finished. */
  protected used(a: { startedAt: string | null; doneAt: string | null }): string {
    if (!a.startedAt) return '';
    const end = a.doneAt ? Date.parse(a.doneAt) : Date.now();
    return `${Math.max(0, Math.round((end - Date.parse(a.startedAt)) / 60_000))}/`;
  }

  protected label(s: DecisionStatus): string {
    return STATUS_LABEL[s];
  }

  protected people(d: Decision): string {
    const parts: string[] = [];
    if (d.proposedBy.length) parts.push(`Proposed by ${d.proposedBy.join(', ')}`);
    if (d.supporters.length) parts.push(`supported by ${d.supporters.join(', ')}`);
    if (d.objectors.length) parts.push(`objections from ${d.objectors.join(', ')}`);
    return parts.join(' · ');
  }

  protected sourcesFor(evidence: number[]): TranscriptLine[] {
    const m = this.bySeq();
    return evidence.map((n) => m.get(n)).filter((l): l is TranscriptLine => !!l);
  }

  protected toggle(id: string): void {
    this.open.set(this.open() === id ? null : id);
  }

  protected due(dueDate: string | null, deadline: string | null): string {
    if (dueDate) {
      const d = new Date(`${dueDate}T00:00:00`);
      return d.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' });
    }
    return deadline ?? '';
  }
}
