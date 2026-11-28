import { ChangeDetectionStrategy, Component, computed, effect, inject, input, signal, untracked } from '@angular/core';
import { DecimalPipe } from '@angular/common';
import { InsightsService, type SessionMetrics } from '../../core/insights';

/** How this meeting went, in numbers: participation, agenda, decisions, follow-through. */
@Component({
  selector: 'app-session-analytics',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (m(); as m) {
      <div class="tiles">
        <div class="tile"><span class="v">{{ m.durationMinutes | number: '1.0-0' }}<small> min</small></span><span class="l">Length</span></div>
        <div class="tile"><span class="v">{{ pct(m.agenda.completion) }}</span><span class="l">Agenda done</span></div>
        <div class="tile"><span class="v">{{ m.decisions.agreed }}</span><span class="l">Decisions confirmed</span></div>
        <div class="tile">
          <span class="v">{{ m.decisions.avgMinutesToDecide === null ? '–' : m.decisions.avgMinutesToDecide }}@if (m.decisions.avgMinutesToDecide !== null) {<small> min</small>}</span>
          <span class="l">Avg. time to decide</span>
        </div>
        <div class="tile"><span class="v">{{ m.unresolved }}</span><span class="l">Left unresolved</span></div>
        <div class="tile"><span class="v">{{ pct(m.tasks.completion) }}</span><span class="l">Tasks done ({{ m.tasks.done }}/{{ m.tasks.total }})</span></div>
      </div>

      @if (m.speakers.length) {
        <div class="part">
          <div class="part-head">
            <h4>Speaking time</h4>
            @if (m.balance !== null) {
              <span class="bal" [title]="'1 = everyone spoke equally, 0 = one person did all the talking'">
                Balance {{ m.balance }} · {{ balanceLabel(m.balance) }}
              </span>
            }
          </div>
          <ul class="bars" role="list">
            @for (s of m.speakers; track s.name) {
              <li [title]="s.name + ': ' + mins(s.seconds) + ', ' + s.lines + ' turns, ' + pct(s.share) + ' of speaking time'">
                <span class="name">{{ s.name }}</span>
                <span class="track"><span class="fill" [style.width.%]="(s.seconds / maxSeconds()) * 100"></span></span>
                <span class="val">{{ mins(s.seconds) }} · {{ pct(s.share) }}</span>
              </li>
            }
          </ul>
        </div>
      }
    } @else if (failed()) {
      <p class="muted">Analytics aren't available for this session.</p>
    } @else {
      <p class="muted">Loading…</p>
    }
  `,
  styles: `
    :host { display: block; }
    .tiles { display: grid; grid-template-columns: repeat(auto-fit, minmax(130px, 1fr)); gap: 10px; }
    .tile { display: flex; flex-direction: column; gap: 4px; padding: 12px 14px; background: var(--surface-sunken); border: 1px solid #262626; }
    .v { font-size: 22px; font-weight: 600; font-variant-numeric: tabular-nums; small { font-size: 13px; font-weight: 400; color: var(--text-muted); } }
    .l { color: var(--text-muted); font-size: 12.5px; }
    .part { margin-top: 18px; }
    .part-head { display: flex; justify-content: space-between; align-items: baseline; gap: 12px; flex-wrap: wrap; }
    h4 { margin: 0 0 10px; font-size: 13px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.05em; color: var(--text-muted); }
    .bal { color: var(--text-muted); font-size: 12.5px; }
    .bars { list-style: none; margin: 0; padding: 0; }
    .bars li { display: grid; grid-template-columns: minmax(80px, 160px) 1fr auto; gap: 10px; align-items: center; padding: 5px 0; font-size: 14px; }
    .name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .track { height: 10px; background: #1f1f1f; }
    .fill { display: block; height: 100%; min-width: 2px; background: var(--brand); border-radius: 0 4px 4px 0; }
    .val { color: var(--text-muted); font-size: 12.5px; font-variant-numeric: tabular-nums; }
    .muted { margin: 0; color: var(--text-muted); font-size: 14px; }
    @media (max-width: 520px) { .bars li { grid-template-columns: 90px 1fr; } .val { grid-column: 2; } }
  `,
  imports: [DecimalPipe],
})
export class SessionAnalytics {
  readonly sessionId = input.required<string>();
  private readonly api = inject(InsightsService);
  protected readonly m = signal<SessionMetrics | null>(null);
  protected readonly failed = signal(false);
  protected readonly maxSeconds = computed(() => Math.max(1, ...(this.m()?.speakers ?? []).map((s) => s.seconds)));

  constructor() {
    effect(() => {
      const id = this.sessionId();
      untracked(() => {
        this.m.set(null);
        this.failed.set(false);
        this.api.sessionMetrics(id).then(
          (r) => this.m.set(r.metrics),
          () => this.failed.set(true),
        );
      });
    });
  }

  protected pct(x: number | null): string {
    return x === null ? '–' : `${Math.round(x * 100)}%`;
  }

  protected mins(sec: number): string {
    return sec < 60 ? `${sec}s` : `${Math.round(sec / 60)} min`;
  }

  protected balanceLabel(b: number): string {
    return b >= 0.85 ? 'even' : b >= 0.65 ? 'fairly even' : 'dominated by a few';
  }
}
