import { ChangeDetectionStrategy, Component, computed, input, output, signal } from '@angular/core';
import type { ActionItem, Decision, DecisionStatus, Insights, TranscriptLine } from '../core/insights';
import { Icon } from './icon';

const STATUS_LABEL: Record<DecisionStatus, string> = {
  disputed: 'Needs confirmation',
  proposed: 'Suggested',
  agreed: 'Confirmed',
  rejected: 'Dropped',
  superseded: 'Replaced',
};

/** Order: things the team must act on first. */
const STATUS_ORDER: DecisionStatus[] = ['disputed', 'proposed', 'agreed', 'rejected', 'superseded'];

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
    @if (live() && i.copilot; as cp) {
      <section class="block copilot" aria-live="polite">
        <h3><app-icon name="sparkles" [size]="13" /> Copilot</h3>
        @if (cp.offTopic) {
          <p class="drift"><app-icon name="alert" [size]="14" /> Off topic{{ cp.offTopicNote ? ': ' + cp.offTopicNote : '' }}</p>
        }
        @if (cp.repeating) {
          <p class="drift"><app-icon name="alert" [size]="14" /> Going in circles{{ cp.repetitionNote ? ': ' + cp.repetitionNote : '' }}</p>
        }
        @if (cp.currentFocus) { <p class="focus"><span class="k">Now</span> {{ cp.currentFocus }}</p> }
        @if (cp.suggestions; as list) {
          @if (list.length) {
            <ul class="sugs">
              @for (x of list; track x.key) {
                <li [class]="'sug k-' + x.kind">
                  <span class="sug-kind">{{ kindLabel(x.kind) }}</span>
                  <span class="sug-text">{{ x.kind === 'question' || x.kind === 'unanswered' || x.kind === 'from_history' ? '“' + x.text + '”' : x.text }}</span>
                  @if (x.why) { <span class="sug-why">{{ x.why }}</span> }
                  <span class="sug-acts">
                    <button type="button" class="mini" title="Useful" aria-label="Useful" (click)="copilotFeedback.emit({ key: x.key, kind: x.kind, action: 'useful' }); thanked.set(x.key)">
                      {{ thanked() === x.key ? 'Thanks' : 'Useful' }}
                    </button>
                    <button type="button" class="mini" title="Not now – don't suggest again" aria-label="Dismiss" (click)="copilotFeedback.emit({ key: x.key, kind: x.kind, action: 'dismiss' })">Dismiss</button>
                  </span>
                </li>
              }
            </ul>
          } @else {
            <p class="quiet">Nothing to add right now.</p>
          }
        } @else {
          @if (cp.discussNext) { <p class="focus"><span class="k">Next</span> {{ cp.discussNext }}</p> }
          @if (cp.agendaAdvice) { <p class="focus"><span class="k">Time</span> {{ cp.agendaAdvice }}</p> }
        }
      </section>
    }
    @if (live() && i.screen?.observations?.length) {
      @let o = i.screen!.observations[i.screen!.observations.length - 1];
      <section class="block onscreen">
        <h3><app-icon name="monitor" [size]="13" /> On screen</h3>
        <p class="focus"><span class="k">{{ o.sharer }}</span> {{ o.app }} – {{ o.summary }}</p>
        @for (e of o.visibleErrors; track $index) { <p class="err-line">{{ e }}</p> }
        @if (o.issue.suspected && o.issue.description) { <p class="sub">Possible issue</p><p class="focus">{{ o.issue.description }}</p> }
      </section>
    }
    @if (openRisks().length) {
      <section class="block">
        <h3>Risks &amp; conflicts <span class="n warn">{{ openRisks().length }}</span></h3>
        @for (r of openRisks(); track r.id) {
          <article class="card risk" [class]="'card risk sev-' + r.severity">
            <div class="card-head">
              <span class="chip risk-chip">{{ riskLabel(r.kind) }}</span>
              <span class="topic">{{ r.severity }} risk</span>
            </div>
            <p class="statement">{{ r.description }}</p>
            @if (r.earlier; as e) {
              <p class="conflict"><app-icon name="alert" [size]="14" /> Also open since {{ e.date }} (“{{ e.title }}”): {{ e.text }}</p>
            }
            @if (r.suggestedQuestion) {
              <p class="ask"><app-icon name="sparkles" [size]="14" /> {{ r.suggestedQuestion }}</p>
            }
            @if (r.involves.length) { <p class="who">Involves {{ r.involves.join(', ') }}</p> }
            @if (sourcesFor(r.evidence).length) {
              <button type="button" class="src-btn" (click)="toggle(r.id)">
                {{ open() === r.id ? 'Hide' : 'Show' }} sources ({{ sourcesFor(r.evidence).length }})
              </button>
              @if (open() === r.id) {
                <ul class="sources">
                  @for (l of sourcesFor(r.evidence); track l.seq) { <li><strong>{{ l.speakerName }}:</strong> “{{ l.text }}”</li> }
                </ul>
              }
            }
          </article>
        }
      </section>
    }
    @if (i.carryover; as c) {
      <section class="block carry">
        <h3>From last meeting</h3>
        <p class="carry-from">“{{ c.fromTitle }}”{{ c.fromDate ? ", " + c.fromDate : "" }}</p>
        <ul>
          @for (t of c.tasks; track $index) {
            <li>{{ t.task }} – {{ t.owner || "no owner" }}@if (t.dueDate) {, due {{ t.dueDate }}}@if (t.overdue) {<span class="overdue"> · overdue</span>}</li>
          }
          @for (d of c.decisions; track $index) {
            <li>Undecided: {{ d.statement }}@if (d.options.length) { ({{ d.options.join(" vs ") }})}</li>
          }
        </ul>
      </section>
    }
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
    @if (keyPoints().length) {
      <section class="block">
        <h3>Key points</h3>
        <ul class="points">
          @for (k of keyPoints(); track k.id) {
            <li [class.high]="k.importance === 'high'">@if (k.kind && k.kind !== 'fact') { <span class="tag">{{ k.kind }}</span> }{{ k.point }}</li>
          }
        </ul>
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
            @if (d.finality && d.finality !== 'final') { <span class="chip fin">{{ d.finality === 'conditional' ? 'Conditional' : 'Tentative' }}</span> }
            @if (d.reversed) { <span class="chip rev">Changed in meeting</span> }
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
          @if (d.condition) { <p class="cond">Only if {{ d.condition }}</p> }
          @if (d.history?.length) {
            <button type="button" class="src-btn" (click)="toggle('h-' + d.id)">{{ open() === 'h-' + d.id ? 'Hide' : 'Show' }} how it changed ({{ d.history!.length }})</button>
            @if (open() === 'h-' + d.id) {
              <ol class="hist">
                @for (h of d.history; track $index) { <li><span class="when">{{ clock(h.at) }}</span> {{ label(h.status) }}: {{ h.statement }}</li> }
                <li><span class="when">now</span> {{ label(d.status) }}: {{ d.statement }}</li>
              </ol>
            }
          }
          @if (d.status === 'disputed' && d.options.length) {
            <div class="options">
              @for (o of d.options; track o) { <span class="opt">{{ o }}</span> }
            </div>
          }
          @if (d.contradicts; as p) {
            <p class="conflict"><app-icon name="alert" [size]="14" /> Goes against the decision of {{ p.date }} (“{{ p.title }}”): {{ p.statement }}</p>
          }
          @if (d.confirmationNeeded) {
            <p class="ask"><app-icon name="sparkles" [size]="14" /> {{ d.confirmationNeeded }}</p>
          }
          <p class="who">{{ people(d) }}</p>
          @if (meta(d); as m) { <p class="meta-line">{{ m }}</p> }
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

    @if (assumptions().length) {
      <section class="block">
        <h3>Assumptions <span class="n">{{ assumptions().length }}</span></h3>
        <p class="note">Treated as true but not confirmed. Check them before relying on them.</p>
        <ul class="points">
          @for (a of assumptions(); track a.id) {
            <li [class.struck]="a.status === 'invalidated'">
              {{ a.statement }}@if (a.madeBy) { <span class="asked">— {{ a.madeBy }}</span> }
              @if (a.status !== 'unverified') { <span class="tag">{{ a.status }}</span> }
            </li>
          }
        </ul>
      </section>
    }

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
                <div class="task">{{ a.task }}@if (a.commitment === 'tentative') { <span class="tag">tentative</span> }</div>
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
                  @if (meta(a); as m) { <span class="sep">·</span> <span class="meta-line inline">{{ m }}</span> }
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

    @if (answered().length) {
      <section class="block">
        <h3>Answered <span class="n">{{ answered().length }}</span></h3>
        <ul class="questions">
          @for (q of answered(); track q.id) { <li>{{ q.question }}@if (q.answer) { <span class="asked"> → {{ q.answer }}</span> }</li> }
        </ul>
      </section>
    }

    @if (i.statementChanges?.length) {
      <section class="block">
        <h3>Changed positions &amp; corrections <span class="n">{{ i.statementChanges!.length }}</span></h3>
        <ul class="questions">
          @for (c of i.statementChanges; track c.id) {
            <li>
              <strong>{{ c.person }}</strong> {{ c.kind === 'corrected' ? 'corrected' : 'changed position' }}@if (c.topic) { on {{ c.topic }}}:
              <span class="was">{{ c.before }}</span> → {{ c.after }}
              @if (meta(c); as m) { <span class="asked"> · {{ m }}</span> }
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
    .carry { padding: 12px 14px; background: var(--surface-sunken); border-left: 3px solid #6b8cff;
      ul { margin: 6px 0 0; padding-left: 18px; font-size: 14.5px; line-height: 1.5; } li { margin: 3px 0; } }
    .carry-from { margin: -4px 0 0; color: var(--text-muted); font-size: 13px; }
    .overdue { color: var(--danger); font-size: 12.5px; }
    .conflict { display: flex; gap: 6px; align-items: flex-start; margin: 6px 0 0; color: #f5b453; font-size: 13.5px; line-height: 1.45;
      app-icon { flex: none; margin-top: 2px; } }
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

    .copilot { padding: 12px 14px; background: var(--surface-sunken); border-left: 3px solid #9db4ff; }
    .copilot h3 { color: #9db4ff; }
    .onscreen { padding: 12px 14px; background: var(--surface-sunken); border-left: 3px solid #c9a7ff; }
    .err-line { margin: 6px 0 0; font-family: ui-monospace, Consolas, monospace; font-size: 12.5px; color: #ff9b9b; word-break: break-word; }
    .sugs { list-style: none; margin: 10px 0 0; padding: 0; }
    .sug { display: grid; grid-template-columns: auto 1fr; gap: 2px 8px; padding: 8px 0; border-top: 1px solid #2a2a2a; font-size: 14px; line-height: 1.45; }
    .sug-kind { grid-row: span 3; align-self: start; padding: 1px 6px; border: 1px solid currentColor; font-size: 11px; font-weight: 600; color: #9db4ff; }
    .k-missing_consideration .sug-kind { color: #ffcf73; }
    .k-from_history .sug-kind { color: #c9a7ff; }
    .k-unanswered .sug-kind { color: #ff9b9b; }
    .k-next_topic .sug-kind, .k-agenda .sug-kind { color: var(--brand); }
    .sug-text { color: var(--text); }
    .sug-why { color: var(--text-muted); font-size: 12.5px; }
    .sug-acts { display: flex; gap: 6px; margin-top: 2px; }
    .mini { padding: 1px 8px; background: none; border: 1px solid #3a3a3a; color: var(--text-muted); font-size: 12px; cursor: pointer; }
    .mini:hover { color: var(--text); border-color: #555; }
    .quiet { margin: 8px 0 0; color: var(--text-placeholder); font-size: 13px; }
    .focus { display: flex; gap: 8px; margin: 6px 0 0; font-size: 14px; line-height: 1.45; }
    .focus .k { flex: none; width: 38px; color: var(--text-muted); font-size: 12px; text-transform: uppercase; letter-spacing: 0.04em; padding-top: 2px; }
    .drift { display: flex; gap: 6px; align-items: flex-start; margin: 0 0 8px; color: #ffb020; font-size: 13.5px; app-icon { flex: none; margin-top: 2px; } }
    .sub { margin: 12px 0 4px; color: var(--text-muted); font-size: 12px; text-transform: uppercase; letter-spacing: 0.04em; }
    .plain { margin: 0; padding-left: 18px; font-size: 14px; line-height: 1.5; li { margin: 2px 0; } }
    .qs li { color: #cfd9ff; }
    .n.warn { background: rgba(255, 176, 32, 0.18); color: #ffcf73; }
    .card.risk { border-left-color: #ffb020; }
    .card.risk.sev-high { border-left-color: var(--danger); }
    .card.risk.sev-low { border-left-color: #666; }
    .risk-chip { color: #ffb020; }
    .sev-high .risk-chip { color: var(--danger); }
    .points { margin: 0; padding-left: 18px; font-size: 14.5px; line-height: 1.5; li { margin: 4px 0; } li.high { font-weight: 500; } li.struck { text-decoration: line-through; color: var(--text-muted); } }
    .note { margin: -6px 0 8px; color: var(--text-muted); font-size: 13px; }
    .tag { margin: 0 6px; padding: 0 6px; border: 1px solid var(--border); font-size: 11.5px; color: var(--text-muted); font-weight: 400; }
    .chip.fin { color: #c9a7ff; }
    .chip.rev { color: #ffb020; }
    .chip.st-superseded { color: var(--text-muted); }
    .card.st-superseded { opacity: 0.55; }
    .cond { margin: 6px 0 0; color: #c9a7ff; font-size: 13.5px; }
    .hist { margin: 6px 0 0; padding-left: 18px; font-size: 13px; color: #cfcfcf; li { margin: 3px 0; } .when { color: var(--text-muted); margin-right: 6px; font-variant-numeric: tabular-nums; } }
    .meta-line { margin: 6px 0 0; color: var(--text-placeholder); font-size: 12px; }
    .meta-line.inline { margin: 0; }
    .was { text-decoration: line-through; color: var(--text-muted); }
  `,
})
export class InsightsView {
  readonly insights = input.required<Insights>();
  /** Transcript lines for "Show sources" (only on the notes page). */
  readonly lines = input<TranscriptLine[]>([]);
  readonly compact = input(false);
  /** In the meeting: show the live copilot. */
  readonly live = input(false);
  /** Show edit/delete controls (notes page, after the meeting ended). */
  readonly editable = input(false);
  readonly editDecision = output<Decision>();
  readonly editTask = output<ActionItem>();
  readonly deleteItem = output<{ kind: 'decisions' | 'tasks' | 'questions'; id: string }>();
  /** In the meeting: a participant found a copilot suggestion useful, or dismissed it. */
  readonly copilotFeedback = output<{ key: string; kind: string; action: 'useful' | 'dismiss' }>();
  protected readonly thanked = signal<string | null>(null);

  protected kindLabel(k: string): string {
    return (
      { question: 'Ask', missing_consideration: 'Consider', next_topic: 'Move on', agenda: 'Time', from_history: 'Earlier', unanswered: 'Unanswered' } as Record<string, string>
    )[k] ?? 'Tip';
  }

  protected readonly open = signal<string | null>(null);

  protected readonly decisions = computed(() =>
    [...this.insights().decisions].sort((a, b) => STATUS_ORDER.indexOf(a.status) - STATUS_ORDER.indexOf(b.status)),
  );
  protected readonly openQuestions = computed(() => this.insights().openQuestions.filter((q) => q.status === 'open'));
  protected readonly openRisks = computed(() => {
    const rank = { high: 0, medium: 1, low: 2 } as const;
    return (this.insights().risks ?? []).filter((r) => r.status === 'open').sort((a, b) => rank[a.severity] - rank[b.severity]);
  });
  protected readonly assumptions = computed(() => this.insights().assumptions ?? []);
  protected readonly answered = computed(() => this.insights().openQuestions.filter((q) => q.status === 'answered'));

  protected clock(iso: string | null | undefined): string {
    return iso ? new Date(iso).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' }) : '';
  }

  /** "Asha, Ben · 10:41–10:48 · 85% sure" – who said it, when, and how sure the AI is. */
  protected meta(x: { trace?: { firstAt: string | null; lastAt: string | null; speakers: string[] } | null; confidence?: number | null }): string {
    const parts: string[] = [];
    const t = x.trace;
    if (t?.speakers.length) parts.push(t.speakers.join(', '));
    if (t?.firstAt) {
      const a = this.clock(t.firstAt);
      const b = this.clock(t.lastAt);
      parts.push(b && b !== a ? `${a}–${b}` : a);
    }
    if (typeof x.confidence === 'number') parts.push(`${Math.round(x.confidence * 100)}% sure`);
    return parts.join(' · ');
  }
  protected readonly keyPoints = computed(() =>
    [...(this.insights().keyPoints ?? [])].sort((a, b) => Number(b.importance === 'high') - Number(a.importance === 'high')),
  );

  protected riskLabel(k: string): string {
    return (
      { conflict: 'Conflict', dependency: 'Dependency', deadline: 'Risky deadline', blocker: 'Blocker', contradiction: 'Contradiction', other: 'Risk' }[k] ??
      'Risk'
    );
  }
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
