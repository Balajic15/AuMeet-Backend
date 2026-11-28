import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { DatePipe } from '@angular/common';
import { RouterLink } from '@angular/router';
import { MemoryService, type Commitments } from '../../core/memory.service';
import type { FollowAction } from '../../core/insights';
import { Icon } from '../../shared/icon';

/** Organisational memory at a glance: who owns what across meetings, what is late, what needs my approval. */
@Component({
  selector: 'app-team-commitments',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink, Icon, DatePipe],
  template: `
    @if (loading()) {
      <p class="muted pad">Loading…</p>
    } @else if (c(); as c) {
      @if (pending().length) {
        <section class="sec">
          <h3><app-icon name="mail" [size]="14" /> Follow-ups waiting for you <span class="n">{{ pending().length }}</span></h3>
          <ul class="list">
            @for (a of pending(); track a.id) {
              <li>
                <a [routerLink]="['/', a.meetingCode, 'insights']">{{ a.title }}</a>
                <small>{{ kind(a.kind) }}@if (a.recipients.length) { to {{ names(a) }} } · {{ a.meetingTitle }}</small>
              </li>
            }
          </ul>
        </section>
      }

      <p class="totals">
        <span><b>{{ c.totals.open }}</b> open</span>
        <span [class.late]="c.totals.overdue"><b>{{ c.totals.overdue }}</b> overdue</span>
        <span><b>{{ c.totals.unowned }}</b> without an owner</span>
        <span><b>{{ c.totals.done }}</b> done</span>
        <a routerLink="/analytics" class="an">Analytics →</a>
      </p>

      @if (!c.owners.length) {
        <p class="muted pad">No open commitments in your meetings.</p>
      }
      @for (o of c.owners; track o.owner ?? '') {
        <section class="sec">
          <h3>{{ o.owner ?? 'No owner yet' }} <span class="n">{{ o.open }}</span>@if (o.overdue) { <span class="n late">{{ o.overdue }} overdue</span> }</h3>
          <ul class="list">
            @for (t of o.tasks; track t.sessionId + t.id) {
              <li>
                <span [class.late]="t.overdue">{{ t.task }}</span>
                <small>
                  @if (t.dueDate) { due {{ t.dueDate | date: 'EEE d MMM' }} · }
                  <a [routerLink]="['/', t.meetingCode, 'insights']">{{ t.meetingTitle }}</a>
                </small>
              </li>
            }
          </ul>
        </section>
      }

      @if (c.risks.length) {
        <section class="sec">
          <h3><app-icon name="alert" [size]="14" /> Open risks <span class="n">{{ c.risks.length }}</span></h3>
          <ul class="list">
            @for (r of c.risks; track r.sessionId + r.id) {
              <li>{{ r.description }} <small>{{ r.severity }} · <a [routerLink]="['/', r.meetingCode, 'insights']">{{ r.meetingTitle }}</a></small></li>
            }
          </ul>
        </section>
      }
    } @else {
      <p class="muted pad">Could not load commitments.</p>
    }
  `,
  styles: `
    :host { display: block; padding: 8px 0; }
    .muted { color: var(--text-muted); font-size: 14px; margin: 0; }
    .pad { padding: 24px 4px; }
    .totals { display: flex; flex-wrap: wrap; gap: 18px; align-items: baseline; margin: 8px 0 16px; color: var(--text-muted); font-size: 14px; b { color: var(--text); font-size: 18px; } }
    .late, .totals .late b { color: #ffb020; }
    .an { margin-left: auto; font-size: 14px; }
    .sec { margin-bottom: 18px; }
    h3 { display: flex; align-items: center; gap: 8px; margin: 0 0 6px; font-size: 14px; font-weight: 600; }
    .n { padding: 0 7px; border-radius: 99px; background: #2a2a2a; font-size: 11.5px; font-weight: 500; }
    .n.late { background: rgba(255, 176, 32, 0.15); }
    .list { list-style: none; margin: 0; padding: 0; }
    .list li { padding: 7px 0; border-bottom: 1px solid #222; font-size: 14.5px; line-height: 1.45; }
    small { display: block; color: var(--text-muted); font-size: 12.5px; }
  `,
})
export class TeamCommitments {
  private readonly memory = inject(MemoryService);
  protected readonly c = signal<Commitments | null>(null);
  protected readonly pending = signal<Array<FollowAction & { meetingTitle?: string }>>([]);
  protected readonly loading = signal(true);

  constructor() {
    void this.load();
  }

  private async load(): Promise<void> {
    try {
      const [c, p] = await Promise.all([this.memory.commitments(), this.memory.pendingActions().catch(() => ({ actions: [] }))]);
      this.c.set(c);
      this.pending.set(p.actions);
    } catch {
      this.c.set(null);
    } finally {
      this.loading.set(false);
    }
  }

  protected kind(k: FollowAction['kind']): string {
    return { email: 'Email', reminder: 'Reminder', calendar: 'Calendar invite', task_sync: 'Project tool' }[k];
  }

  protected names(a: FollowAction): string {
    return a.recipients.map((r) => r.name).join(', ');
  }
}
