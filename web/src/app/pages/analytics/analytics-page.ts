import { ChangeDetectionStrategy, Component, computed, effect, inject, signal, untracked } from '@angular/core';
import { DatePipe } from '@angular/common';
import { RouterLink } from '@angular/router';
import { apiErrorMessage } from '../../core/auth.service';
import { AnalyticsService, type AnalyticsInsight, type AnalyticsOverview, type AnalyticsSummary } from '../../core/memory.service';
import { Icon } from '../../shared/icon';
import { UserMenu } from '../../shared/user-menu';

type Fmt = 'num' | 'pct' | 'min' | 'ratio';
interface Tile {
  key: keyof AnalyticsSummary;
  label: string;
  fmt: Fmt;
  /** Whether a higher number is better (colours the change); null = neutral. */
  higherIsBetter: boolean | null;
}

const TILES: Tile[] = [
  { key: 'meetings', label: 'Meetings', fmt: 'num', higherIsBetter: null },
  { key: 'hours', label: 'Hours in meetings', fmt: 'num', higherIsBetter: false },
  { key: 'avgMinutes', label: 'Avg. length', fmt: 'min', higherIsBetter: false },
  { key: 'avgBalance', label: 'Participation balance', fmt: 'ratio', higherIsBetter: true },
  { key: 'agendaCompletion', label: 'Agenda completion', fmt: 'pct', higherIsBetter: true },
  { key: 'decisionsPerMeeting', label: 'Decisions per meeting', fmt: 'num', higherIsBetter: true },
  { key: 'avgMinutesToDecide', label: 'Avg. time to decide', fmt: 'min', higherIsBetter: false },
  { key: 'unresolvedPerMeeting', label: 'Unresolved per meeting', fmt: 'num', higherIsBetter: false },
  { key: 'taskCompletion', label: 'Tasks completed', fmt: 'pct', higherIsBetter: true },
  { key: 'goalMetRate', label: 'Goals met', fmt: 'pct', higherIsBetter: true },
];

/** Meeting effectiveness across all the meetings I can see. */
@Component({
  selector: 'app-analytics-page',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink, Icon, UserMenu, DatePipe],
  template: `
    <header class="topbar">
      <a routerLink="/"><img src="aumeet-logo.png" alt="AuMeet" class="wordmark" /></a>
      <app-user-menu />
    </header>
    <main class="wrap">
      <a routerLink="/" class="back"><app-icon name="arrow-left" [size]="16" /> All meetings</a>
      <div class="head">
        <div>
          <p class="eyebrow"><app-icon name="sparkles" [size]="14" /> Analytics</p>
          <h1>Meeting effectiveness</h1>
        </div>
        <div class="period" role="group" aria-label="Period">
          @for (d of periods; track d) {
            <button type="button" [class.active]="days() === d" (click)="days.set(d)">{{ d }} days</button>
          }
        </div>
      </div>

      @if (loading()) {
        <div class="center"><span class="spinner"></span></div>
      } @else if (error()) {
        <p class="err">{{ error() }}</p>
      } @else if (data(); as o) {
        @if (o.summary.meetings === 0) {
          <div class="empty">No meetings with AI notes in the last {{ o.days }} days.</div>
        } @else {
          <section class="tiles">
            @for (t of tiles; track t.key) {
              <div class="tile">
                <span class="l">{{ t.label }}</span>
                <span class="v">{{ fmt(o.summary[t.key], t.fmt) }}</span>
                @if (delta(o, t); as d) {
                  <span class="d" [class.good]="d.good === true" [class.bad]="d.good === false">{{ d.text }} vs previous {{ o.days }} days</span>
                }
              </div>
            }
          </section>
          @if (o.summary.overdueTasks || o.summary.meetingsWithoutOutcome) {
            <p class="flags">
              @if (o.summary.overdueTasks) { <span><app-icon name="alert" [size]="14" /> {{ o.summary.overdueTasks }} overdue {{ o.summary.overdueTasks === 1 ? 'task' : 'tasks' }}</span> }
              @if (o.summary.meetingsWithoutOutcome) {
                <span><app-icon name="alert" [size]="14" /> {{ o.summary.meetingsWithoutOutcome }} {{ o.summary.meetingsWithoutOutcome === 1 ? 'meeting' : 'meetings' }} ended with no decision and no task</span>
              }
            </p>
          }

          <section class="card">
            <div class="card-head">
              <h2>Recommendations</h2>
              @if (o.aiEnabled) {
                <button type="button" class="btn btn-outline small" [disabled]="thinking()" (click)="recommend()">
                  @if (thinking()) { <span class="spinner"></span> } {{ insights().length ? 'Refresh' : 'Get recommendations' }}
                </button>
              }
            </div>
            @if (insights().length) {
              <ul class="ins">
                @for (x of insights(); track $index) {
                  <li [class]="'k-' + x.kind">
                    <span class="badge">{{ kindLabel(x.kind) }}</span>
                    <div><strong>{{ x.title }}</strong><p>{{ x.detail }}</p></div>
                  </li>
                }
              </ul>
            } @else {
              <p class="muted">The AI reads these numbers and suggests what to change, such as which meetings to shorten or drop, and how to balance participation.</p>
            }
          </section>

          <div class="grid">
            <section class="card">
              <h2>Meetings per week</h2>
              @if (o.weeks.length) {
                <div class="cols" role="list">
                  @for (w of o.weeks; track w.week) {
                    <div class="col" role="listitem"
                         [title]="'Week of ' + (w.week | date: 'd MMM') + ': ' + w.meetings + ' meetings, ' + w.hours + ' h, ' + w.decisions + ' decisions, ' + w.tasksDone + '/' + w.tasks + ' tasks done'">
                      <span class="cv">{{ w.meetings }}</span>
                      <span class="bar" [style.height.%]="(w.meetings / maxWeek()) * 100"></span>
                      <span class="cl">{{ w.week | date: 'd MMM' }}</span>
                    </div>
                  }
                </div>
              }
            </section>
            <section class="card">
              <h2>Speaking time</h2>
              <ul class="bars">
                @for (p of o.people.slice(0, 10); track p.name) {
                  <li [title]="p.name + ': ' + p.minutes + ' min across ' + p.meetings + ' meetings, avg. ' + pctOf(p.avgShare) + ' of the talking'">
                    <span class="name">{{ p.name }}</span>
                    <span class="track"><span class="fill" [style.width.%]="(p.minutes / maxMinutes()) * 100"></span></span>
                    <span class="val">{{ p.minutes }} min</span>
                  </li>
                }
              </ul>
            </section>
          </div>

          @if (o.recurringTopics.length) {
            <section class="card">
              <h2>Recurring topics</h2>
              <p class="muted">Discussed in several meetings. Worth settling once.</p>
              <div class="chips">
                @for (t of o.recurringTopics; track t.title) { <span class="chip">{{ t.title }} <b>{{ t.meetings }}×</b></span> }
              </div>
            </section>
          }

          <section class="card">
            <h2>Meetings</h2>
            <div class="table-wrap">
              <table>
                <thead>
                  <tr><th>Meeting</th><th>Length</th><th>People</th><th>Balance</th><th>Agenda</th><th>Decisions</th><th>Tasks done</th><th>Unresolved</th></tr>
                </thead>
                <tbody>
                  @for (s of o.sessions; track s.sessionId) {
                    <tr>
                      <td><a [routerLink]="['/', s.meetingCode, 'insights']">{{ s.title }}</a><small>{{ s.startedAt | date: 'd MMM, HH:mm' }}</small></td>
                      <td>{{ s.durationMinutes }} min</td>
                      <td>{{ s.participants }}</td>
                      <td>{{ s.balance ?? '–' }}</td>
                      <td>{{ pctOf(s.agenda.completion) }}</td>
                      <td>{{ s.decisions.agreed }}</td>
                      <td>{{ s.tasks.total ? s.tasks.done + '/' + s.tasks.total : '–' }}</td>
                      <td>{{ s.unresolved }}</td>
                    </tr>
                  }
                </tbody>
              </table>
            </div>
          </section>
        }
      }
    </main>
  `,
  styles: `
    :host { display: block; min-height: 100dvh; }
    .topbar { display: flex; align-items: center; justify-content: space-between; padding: 10px 32px; border-bottom: 1px solid #1c1c1c; }
    .wordmark { height: 46px; width: auto; display: block; margin-left: -12px; }
    .wrap { max-width: 1040px; margin: 0 auto; padding: 28px 24px 80px; }
    .back { display: inline-flex; align-items: center; gap: 6px; color: var(--text-muted); font-size: 14px; }
    .head { display: flex; justify-content: space-between; align-items: flex-end; gap: 16px; flex-wrap: wrap; margin: 24px 0 20px; }
    .eyebrow { display: flex; align-items: center; gap: 6px; margin: 0 0 6px; color: var(--brand); font-size: 13px; font-weight: 600; }
    h1 { margin: 0; font-size: 30px; font-weight: 600; }
    .period { display: inline-flex; border: 1px solid var(--border); }
    .period button { padding: 8px 14px; background: none; border: none; color: var(--text-muted); font-size: 14px; cursor: pointer; }
    .period button.active { background: #232323; color: var(--text); }
    .center { display: flex; justify-content: center; padding: 80px 0; }
    .err { color: var(--danger); }
    .empty { padding: 56px 24px; text-align: center; color: var(--text-muted); background: var(--surface); border: 1px solid #222; }
    .tiles { display: grid; grid-template-columns: repeat(auto-fill, minmax(180px, 1fr)); gap: 10px; }
    .tile { display: flex; flex-direction: column; gap: 4px; padding: 14px 16px; background: var(--surface); border: 1px solid #222; }
    .l { color: var(--text-muted); font-size: 13px; }
    .v { font-size: 26px; font-weight: 600; font-variant-numeric: tabular-nums; }
    .d { font-size: 12px; color: var(--text-muted); }
    .d.good { color: var(--brand); }
    .d.bad { color: #ffb020; }
    .flags { display: flex; flex-wrap: wrap; gap: 16px; margin: 12px 0 0; color: #ffcf73; font-size: 14px; span { display: inline-flex; gap: 6px; align-items: center; } }
    .card { margin-top: 16px; padding: 20px 22px; background: var(--surface); border: 1px solid #222; min-width: 0; }
    .card-head { display: flex; justify-content: space-between; align-items: center; gap: 12px; }
    h2 { margin: 0 0 14px; font-size: 14px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.05em; color: var(--text-muted); }
    .card-head h2 { margin: 0; }
    .btn.small { width: auto; height: 34px; padding: 0 14px; font-size: 13.5px; }
    .muted { margin: 8px 0 0; color: var(--text-muted); font-size: 14px; }
    .ins { list-style: none; margin: 14px 0 0; padding: 0; }
    .ins li { display: flex; gap: 12px; padding: 10px 0; border-top: 1px solid #222; p { margin: 4px 0 0; color: #dcdcdc; font-size: 14px; line-height: 1.5; } }
    .badge { flex: none; height: fit-content; padding: 1px 8px; border: 1px solid currentColor; font-size: 11.5px; font-weight: 600; }
    .k-win .badge { color: var(--brand); }
    .k-issue .badge { color: #ffb020; }
    .k-suggestion .badge { color: #9db4ff; }
    .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(320px, 1fr)); gap: 0 16px; }
    .cols { display: flex; align-items: flex-end; gap: 6px; height: 180px; }
    .col { flex: 1; min-width: 0; height: 100%; display: flex; flex-direction: column; justify-content: flex-end; align-items: center; gap: 4px; }
    .bar { width: 100%; max-width: 36px; min-height: 2px; background: var(--brand); border-radius: 4px 4px 0 0; }
    .col:hover .bar { filter: brightness(1.2); }
    .cv { font-size: 12px; color: var(--text-muted); font-variant-numeric: tabular-nums; }
    .cl { font-size: 11px; color: var(--text-muted); white-space: nowrap; }
    .bars { list-style: none; margin: 0; padding: 0; }
    .bars li { display: grid; grid-template-columns: minmax(70px, 140px) 1fr auto; gap: 10px; align-items: center; padding: 5px 0; font-size: 14px; }
    .name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .track { height: 10px; background: #1f1f1f; }
    .fill { display: block; height: 100%; min-width: 2px; background: var(--brand); border-radius: 0 4px 4px 0; }
    .val { color: var(--text-muted); font-size: 12.5px; font-variant-numeric: tabular-nums; }
    .chips { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 12px; }
    .chip { padding: 4px 10px; border: 1px solid var(--border); font-size: 13.5px; b { color: var(--text-muted); font-weight: 500; margin-left: 4px; } }
    .table-wrap { overflow-x: auto; }
    table { width: 100%; border-collapse: collapse; font-size: 14px; }
    th { text-align: left; font-weight: 500; color: var(--text-muted); font-size: 12.5px; padding: 8px 10px; border-bottom: 1px solid #2a2a2a; white-space: nowrap; }
    td { padding: 10px; border-bottom: 1px solid #222; font-variant-numeric: tabular-nums; white-space: nowrap; }
    td:first-child { white-space: normal; min-width: 180px; small { display: block; color: var(--text-muted); font-size: 12px; } }
    @media (max-width: 600px) { .topbar { padding: 10px 16px; } .wrap { padding: 20px 16px 60px; } }
  `,
})
export class AnalyticsPage {
  private readonly api = inject(AnalyticsService);
  protected readonly periods = [7, 30, 90];
  protected readonly tiles = TILES;
  protected readonly days = signal(30);
  protected readonly data = signal<AnalyticsOverview | null>(null);
  protected readonly loading = signal(true);
  protected readonly error = signal<string | null>(null);
  protected readonly insights = signal<AnalyticsInsight[]>([]);
  protected readonly thinking = signal(false);
  protected readonly maxWeek = computed(() => Math.max(1, ...(this.data()?.weeks ?? []).map((w) => w.meetings)));
  protected readonly maxMinutes = computed(() => Math.max(1, ...(this.data()?.people ?? []).map((p) => p.minutes)));

  constructor() {
    effect(() => {
      const d = this.days();
      untracked(() => void this.load(d));
    });
  }

  private async load(days: number): Promise<void> {
    this.loading.set(true);
    this.error.set(null);
    this.insights.set([]);
    try {
      this.data.set(await this.api.overview(days));
    } catch (err) {
      this.error.set(apiErrorMessage(err, 'Could not load analytics.'));
    } finally {
      this.loading.set(false);
    }
  }

  protected async recommend(): Promise<void> {
    this.thinking.set(true);
    try {
      this.insights.set((await this.api.insights(this.days())).insights);
    } catch (err) {
      this.error.set(apiErrorMessage(err, 'Could not get recommendations.'));
    } finally {
      this.thinking.set(false);
    }
  }

  protected fmt(v: number | null, f: Fmt): string {
    if (v === null || v === undefined) return '–';
    if (f === 'pct') return `${Math.round(v * 100)}%`;
    if (f === 'min') return `${v} min`;
    return String(v);
  }

  protected pctOf(v: number | null): string {
    return v === null ? '–' : `${Math.round(v * 100)}%`;
  }

  protected delta(o: AnalyticsOverview, t: Tile): { text: string; good: boolean | null } | null {
    const a = o.summary[t.key];
    const b = o.previous[t.key];
    if (a === null || b === null || o.previous.meetings === 0) return null;
    const diff = Math.round((a - b) * (t.fmt === 'pct' ? 100 : 10)) / (t.fmt === 'pct' ? 1 : 10);
    if (diff === 0) return { text: 'No change', good: null };
    const text = `${diff > 0 ? '+' : ''}${diff}${t.fmt === 'pct' ? ' pts' : t.fmt === 'min' ? ' min' : ''}`;
    return { text, good: t.higherIsBetter === null ? null : diff > 0 === t.higherIsBetter };
  }

  protected kindLabel(k: AnalyticsInsight['kind']): string {
    return { win: 'Going well', issue: 'Problem', suggestion: 'Try this' }[k];
  }
}
