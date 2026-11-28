import { ChangeDetectionStrategy, Component, computed, effect, inject, input, signal, untracked } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { apiErrorMessage } from '../../core/auth.service';
import { InsightsService, type FollowAction } from '../../core/insights';
import { Icon, type IconName } from '../../shared/icon';
import { ToastService } from '../../shared/toast';

const KIND_LABEL: Record<FollowAction['kind'], string> = {
  email: 'Email',
  reminder: 'Reminder',
  calendar: 'Calendar invite',
  task_sync: 'Project tool',
};

/** Host only: what the follow-through agent wants to do after this meeting. Nothing external goes out unapproved. */
@Component({
  selector: 'app-follow-through-panel',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [FormsModule, Icon],
  template: `
    <div class="head">
      <p class="muted">
        The AI drafts follow-ups from the notes. Emails and invites go out only when you approve them;
        reminders to people about their own tasks can run on their own (change this in Account → AI).
      </p>
      @if (canPlan()) {
        <button type="button" class="btn btn-outline small" [disabled]="busy()" (click)="plan()">
          @if (busy()) { <span class="spinner"></span> } {{ actions().length ? 'Re-plan' : 'Plan follow-ups' }}
        </button>
      }
    </div>
    @if (!mail()) { <p class="warn"><app-icon name="alert" [size]="14" /> Email isn't configured on this server, so emails, reminders and invites can't be sent.</p> }

    @if (loading()) {
      <p class="muted">Loading…</p>
    } @else if (!actions().length) {
      <p class="muted">{{ planned() ? 'Nothing needed following up.' : 'Follow-ups are planned a few minutes after the meeting ends.' }}</p>
    } @else {
      @for (a of sorted(); track a.id) {
        <article class="act" [class]="'act s-' + a.status">
          <div class="row">
            <span class="kind"><app-icon [name]="icon(a.kind)" [size]="14" /> {{ kindLabel(a.kind) }}</span>
            @if (a.recipients.length) { <span class="to">to {{ names(a) }}</span> }
            @if (a.when) { <span class="to">· {{ when(a.when) }}</span> }
            <span class="status">{{ statusLabel(a) }}</span>
          </div>
          @if (editing() === a.id) {
            <input class="input" [(ngModel)]="draft.title" maxlength="300" aria-label="Subject" />
            <textarea class="input area" rows="5" [(ngModel)]="draft.body" maxlength="5000" aria-label="Message"></textarea>
            @if (a.when) {
              <label class="when">When <input class="input" type="datetime-local" [(ngModel)]="draft.when" /></label>
            }
            <div class="btns">
              <button type="button" class="btn btn-outline small" (click)="editing.set(null)">Cancel</button>
              <button type="button" class="btn btn-outline small" [disabled]="busy()" (click)="save(a, false)">Save</button>
              <button type="button" class="btn btn-primary small" [disabled]="busy()" (click)="save(a, true)">Save &amp; approve</button>
            </div>
          } @else {
            <p class="title">{{ a.title }}</p>
            @if (a.body) { <p class="body">{{ a.body }}</p> }
            @if (a.reason) { <p class="reason">Why: {{ a.reason }}</p> }
            @if (a.error) {
              <p class="err">{{ a.error }}@if (a.status === 'approved' && a.nextAttemptAt) { · retrying {{ when(a.nextAttemptAt) }} (attempt {{ a.attempts + 1 }}) }</p>
            }
            @if (a.result) {
              <p class="reason">{{ a.result }}@if (a.channel) { · via {{ channelLabel(a.channel) }} }</p>
            }
            @if (a.external; as x) { <p class="reason"><a [href]="x.url" target="_blank" rel="noopener">Open {{ x.key }} in {{ channelLabel(x.provider) }}</a></p> }
            @if (a.status === 'failed') {
              <div class="btns"><button type="button" class="btn btn-outline small" [disabled]="busy()" (click)="retry(a)">Try again</button></div>
            }
            @if (a.status === 'proposed' || (a.status === 'approved' && !a.executedAt)) {
              <div class="btns">
                @if (a.status === 'proposed') {
                  <button type="button" class="btn btn-outline small" [disabled]="busy()" (click)="decide(a, 'dismissed')">Dismiss</button>
                }
                <button type="button" class="btn btn-outline small" (click)="edit(a)">Edit</button>
                @if (a.status === 'proposed') {
                  <button type="button" class="btn btn-primary small" [disabled]="busy()" (click)="decide(a, 'approved')">Approve</button>
                }
              </div>
            }
          }
        </article>
      }
    }
  `,
  styles: `
    :host { display: block; }
    .head { display: flex; gap: 16px; align-items: flex-start; justify-content: space-between; flex-wrap: wrap; margin-bottom: 12px; }
    .muted { margin: 0; color: var(--text-muted); font-size: 13.5px; line-height: 1.5; max-width: 560px; }
    .warn { display: flex; gap: 6px; align-items: center; color: #ffcf73; font-size: 13.5px; margin: 0 0 12px; }
    .btn.small { width: auto; height: 34px; padding: 0 14px; font-size: 13.5px; }
    .act { padding: 12px 14px; margin-bottom: 10px; background: var(--surface-sunken); border: 1px solid #262626; border-left: 3px solid #9db4ff; }
    .act.s-done { border-left-color: var(--brand); opacity: 0.8; }
    .act.s-dismissed { opacity: 0.5; border-left-color: #444; }
    .act.s-failed { border-left-color: var(--danger); }
    .row { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; font-size: 13px; color: var(--text-muted); }
    .kind { display: inline-flex; align-items: center; gap: 5px; color: var(--text); font-weight: 600; }
    .status { margin-left: auto; font-size: 12px; }
    .title { margin: 8px 0 0; font-weight: 500; }
    .body { margin: 6px 0 0; white-space: pre-line; font-size: 14px; line-height: 1.5; color: #dcdcdc; }
    .reason { margin: 6px 0 0; color: var(--text-muted); font-size: 12.5px; }
    .err { margin: 6px 0 0; color: var(--danger); font-size: 13px; }
    .btns { display: flex; gap: 8px; justify-content: flex-end; margin-top: 10px; flex-wrap: wrap; }
    .input { margin-top: 8px; }
    .input.area { height: auto; padding: 10px 12px; line-height: 1.5; resize: vertical; }
    .when { display: flex; align-items: center; gap: 8px; margin-top: 8px; font-size: 13px; color: var(--text-muted); .input { margin: 0; width: auto; } }
  `,
})
export class FollowThroughPanel {
  readonly code = input.required<string>();
  readonly sessionId = input.required<string>();

  private readonly api = inject(InsightsService);
  private readonly toast = inject(ToastService);

  protected readonly actions = signal<FollowAction[]>([]);
  protected readonly loading = signal(true);
  protected readonly busy = signal(false);
  protected readonly planned = signal(false);
  protected readonly canPlan = signal(false);
  protected readonly mail = signal(true);
  protected readonly editing = signal<string | null>(null);
  protected draft = { title: '', body: '', when: '' };

  /** Waiting for a decision first. */
  protected readonly sorted = computed(() => {
    const order = { proposed: 0, approved: 1, failed: 2, done: 3, dismissed: 4 } as const;
    return [...this.actions()].sort((a, b) => order[a.status] - order[b.status]);
  });

  constructor() {
    effect(() => {
      const [code, id] = [this.code(), this.sessionId()];
      untracked(() => void this.load(code, id));
    });
  }

  private async load(code: string, id: string): Promise<void> {
    this.loading.set(true);
    try {
      const r = await this.api.actions(code, id);
      this.actions.set(r.actions);
      this.planned.set(r.planned);
      this.canPlan.set(r.canPlan);
      this.mail.set(r.mail);
    } catch {
      this.actions.set([]);
    } finally {
      this.loading.set(false);
    }
  }

  protected async plan(): Promise<void> {
    this.busy.set(true);
    try {
      const r = await this.api.planActions(this.code(), this.sessionId());
      this.actions.set(r.actions);
      this.planned.set(true);
    } catch (err) {
      this.toast.error(apiErrorMessage(err, 'Could not plan follow-ups.'));
    } finally {
      this.busy.set(false);
    }
  }

  protected edit(a: FollowAction): void {
    this.draft = { title: a.title, body: a.body, when: a.when ? toLocalInput(a.when) : '' };
    this.editing.set(a.id);
  }

  protected save(a: FollowAction, approve: boolean): Promise<void> {
    return this.update(a, {
      title: this.draft.title.trim() || a.title,
      body: this.draft.body,
      ...(this.draft.when ? { when: new Date(this.draft.when).toISOString() } : {}),
      ...(approve ? { status: 'approved' as const } : {}),
    });
  }

  protected decide(a: FollowAction, status: 'approved' | 'dismissed'): Promise<void> {
    return this.update(a, { status });
  }

  private async update(a: FollowAction, body: Parameters<InsightsService['decideAction']>[3]): Promise<void> {
    this.busy.set(true);
    try {
      const r = await this.api.decideAction(this.code(), this.sessionId(), a.id, body);
      this.actions.update((xs) => xs.map((x) => (x.id === a.id ? r.action : x)));
      this.editing.set(null);
      if (r.action.status === 'done') this.toast.show(r.action.result ?? 'Done');
      else if (r.action.status === 'failed') this.toast.error(r.action.error ?? 'It could not be carried out.');
    } catch (err) {
      this.toast.error(apiErrorMessage(err, 'Could not update the action.'));
    } finally {
      this.busy.set(false);
    }
  }

  protected channelLabel(c: string): string {
    const names: Record<string, string> = {
      gmail: 'your Gmail', smtp: 'AuMeet email', google_calendar: 'Google Calendar', ics: 'calendar invite email',
      jira: 'Jira', linear: 'Linear', asana: 'Asana', webhook: 'webhook',
    };
    return c.split('+').map((x) => names[x] ?? x).join(' + ');
  }

  protected async retry(a: FollowAction): Promise<void> {
    this.busy.set(true);
    try {
      const r = await this.api.retryAction(this.code(), this.sessionId(), a.id);
      this.actions.update((xs) => xs.map((x) => (x.id === a.id ? r.action : x)));
      if (r.action.status === 'done') this.toast.show(r.action.result ?? 'Done');
      else if (r.action.status === 'failed') this.toast.error(r.action.error ?? 'It failed again.');
    } catch (err) {
      this.toast.error(apiErrorMessage(err, 'Could not retry.'));
    } finally {
      this.busy.set(false);
    }
  }

  protected kindLabel(k: FollowAction['kind']): string {
    return KIND_LABEL[k];
  }

  protected icon(k: FollowAction['kind']): IconName {
    return ({ email: 'mail', reminder: 'clock', calendar: 'calendar', task_sync: 'link' } as const)[k];
  }

  protected names(a: FollowAction): string {
    return a.recipients.map((r) => r.name).join(', ');
  }

  protected when(iso: string): string {
    return new Date(iso).toLocaleString(undefined, { weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' });
  }

  protected statusLabel(a: FollowAction): string {
    if (a.status === 'approved') return a.executedAt ? 'Sending…' : a.kind === 'reminder' ? 'Scheduled' : 'Approved';
    return { proposed: 'Needs your approval', done: 'Done', dismissed: 'Dismissed', failed: 'Failed' }[a.status];
  }
}

function toLocalInput(iso: string): string {
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
