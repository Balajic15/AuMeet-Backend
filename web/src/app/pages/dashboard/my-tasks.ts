import { ChangeDetectionStrategy, Component, inject, input, output, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { apiErrorMessage } from '../../core/auth.service';
import { MemoryService, type MyTask, type OpenDecision } from '../../core/memory.service';
import { Icon } from '../../shared/icon';
import { ToastService } from '../../shared/toast';

/** "My tasks" tab: tasks assigned to me across meetings, plus decisions waiting on the team. */
@Component({
  selector: 'app-my-tasks',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [Icon, RouterLink],
  template: `
    @if (tasks().length === 0 && decisions().length === 0) {
      <div class="empty">
        <app-icon name="check" [size]="28" />
        <p class="empty-title">Nothing on your plate</p>
        <p>Tasks the AI hears you take on in meetings show up here.</p>
      </div>
    }

    @if (tasks().length) {
      <ul class="tasks">
        @for (t of tasks(); track t.sessionId + t.id) {
          <li [class.done]="t.status === 'done'">
            <button type="button" class="tick" [disabled]="!t.editable || busy() === key(t)"
                    [attr.aria-label]="t.status === 'done' ? 'Mark as not done' : 'Mark as done'"
                    [title]="t.editable ? '' : 'Available after the meeting ends'" (click)="toggle(t)">
              @if (t.status === 'done') { <app-icon name="check" [size]="14" /> }
            </button>
            <div class="body">
              <div class="task">{{ t.task }}</div>
              <div class="meta">
                <a [routerLink]="['/', t.meetingCode, 'insights']">{{ t.meetingTitle }}</a>
                @if (t.dueDate || t.deadline) {
                  <span class="sep">·</span>
                  <span [class.overdue]="overdue(t)"><app-icon name="calendar" [size]="12" /> {{ due(t) }}</span>
                }
              </div>
            </div>
          </li>
        }
      </ul>
    }

    @if (decisions().length) {
      <h3>Waiting on a decision</h3>
      <ul class="decisions">
        @for (d of decisions(); track d.sessionId + d.id) {
          <li>
            <div class="statement">{{ d.statement }}</div>
            @if (d.options.length) { <div class="options">{{ d.options.join(' vs ') }}</div> }
            <a class="from" [routerLink]="['/', d.meetingCode, 'insights']">{{ d.meetingTitle }}</a>
          </li>
        }
      </ul>
    }
  `,
  styles: `
    :host { display: block; padding: 8px 0; }
    .empty { display: flex; flex-direction: column; align-items: center; gap: 8px; padding: 56px 24px; text-align: center; color: var(--text-muted); p { margin: 0; } }
    .empty-title { color: var(--text); font-weight: 600; font-size: 17px; margin-top: 6px !important; }
    .tasks, .decisions { list-style: none; margin: 0; padding: 0; }
    .tasks li { display: flex; gap: 14px; padding: 14px 20px; border-bottom: 1px solid #242424; }
    .tick {
      flex: none; width: 20px; height: 20px; margin-top: 1px; padding: 0; border: 1.5px solid #5a5a5a; border-radius: 4px;
      background: none; display: grid; place-items: center; color: var(--brand-ink); cursor: pointer;
      &:disabled { cursor: default; opacity: 0.5; }
    }
    li.done .tick { background: var(--brand); border-color: var(--brand); opacity: 1; }
    li.done .task { text-decoration: line-through; color: var(--text-muted); }
    .body { min-width: 0; }
    .task { font-size: 15px; line-height: 1.4; }
    .meta { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; margin-top: 4px; font-size: 13px; color: var(--text-muted); }
    .meta a { color: var(--text-muted); &:hover { color: var(--text); } }
    .overdue { color: var(--danger); }
    h3 { margin: 20px 20px 4px; font-size: 13px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.05em; color: #ffb020; }
    .decisions li { padding: 12px 20px; border-bottom: 1px solid #242424; }
    .statement { font-size: 15px; }
    .options { margin-top: 4px; color: var(--text-muted); font-size: 13px; }
    .from { display: inline-block; margin-top: 4px; font-size: 13px; }
  `,
})
export class MyTasks {
  private readonly memory = inject(MemoryService);
  private readonly toast = inject(ToastService);

  readonly tasks = input.required<MyTask[]>();
  readonly decisions = input.required<OpenDecision[]>();
  readonly changed = output<MyTask>();

  protected readonly busy = signal<string | null>(null);
  protected key = (t: MyTask) => `${t.sessionId}:${t.id}`;

  protected async toggle(t: MyTask): Promise<void> {
    const next = t.status === 'done' ? 'open' : 'done';
    this.busy.set(this.key(t));
    try {
      await this.memory.setTaskStatus(t.sessionId, t.id, next);
      this.changed.emit({ ...t, status: next });
    } catch (err) {
      this.toast.error(apiErrorMessage(err, 'Could not update the task.'));
    } finally {
      this.busy.set(null);
    }
  }

  protected due(t: MyTask): string {
    if (t.dueDate) return new Date(`${t.dueDate}T00:00:00`).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' });
    return t.deadline ?? '';
  }

  protected overdue(t: MyTask): boolean {
    return t.status === 'open' && !!t.dueDate && new Date(`${t.dueDate}T23:59:59`) < new Date();
  }
}
