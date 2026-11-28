import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { AiService, type FollowThroughSettings } from '../../core/ai.service';
import { apiErrorMessage } from '../../core/auth.service';
import { ToastService } from '../../shared/toast';

/** What the follow-through agent may do after meetings I host. */
@Component({
  selector: 'app-follow-through-settings',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [FormsModule],
  template: `
    <h2>Follow-through after meetings</h2>
    <p class="hint">
      After a meeting the AI drafts follow-up emails, deadline reminders and calendar invites from the notes, and can push
      tasks to your project tool. You approve every email and invite on the meeting's notes page.
    </p>
    @if (!mail()) { <p class="warn">Email isn't configured on this server yet, so nothing can be sent.</p> }
    @if (s(); as s) {
      <label class="check"><input type="checkbox" [ngModel]="s.enabled" (ngModelChange)="save({ enabled: $event })" /> Plan follow-ups after each meeting</label>
      <label class="check"><input type="checkbox" [ngModel]="s.autoApproveReminders" (ngModelChange)="save({ autoApproveReminders: $event })" />
        Send reminders to people about their own tasks without asking me</label>
      <label class="check"><input type="checkbox" [ngModel]="s.overdueNotices" (ngModelChange)="save({ overdueNotices: $event })" />
        Nudge task owners when a task becomes overdue</label>

      <h3 class="sub-h">Project tool</h3>
      <p class="hint">
        An HTTPS webhook (for example from Zapier, Make, n8n or Slack) that creates tasks in Jira, Linear, Asana, Trello and others.
        AuMeet posts each task, and later its progress, as JSON.
      </p>
      <div class="row">
        <input class="input" type="url" placeholder="https://hooks.zapier.com/…" [(ngModel)]="webhook" aria-label="Webhook URL" />
        <button class="btn btn-outline" type="button" [disabled]="busy()" (click)="save({ webhookUrl: webhook.trim() || null })">Save</button>
      </div>
      @if (s.webhookUrl) {
        <label class="check"><input type="checkbox" [ngModel]="s.autoSyncTasks" (ngModelChange)="save({ autoSyncTasks: $event })" />
          Add new tasks to the project tool without asking me</label>
      }
    } @else {
      <p class="hint">Loading…</p>
    }
  `,
  styles: `
    :host { display: block; }
    h2 { margin: 0 0 18px; font-size: 18px; font-weight: 600; }
    .hint { margin: -6px 0 16px; color: var(--text-muted); font-size: 14px; line-height: 1.5; }
    .sub-h { margin: 24px 0 10px; font-size: 15px; font-weight: 600; }
    .warn { margin: 0 0 14px; color: #ffcf73; font-size: 14px; }
    .check { display: flex; gap: 10px; align-items: flex-start; margin: 0 0 12px; font-size: 14.5px; line-height: 1.45; input { margin-top: 3px; } }
    .row { display: flex; gap: 10px; margin-bottom: 12px; .btn { width: auto; min-width: 90px; height: 44px; } }
  `,
})
export class FollowThroughSettingsCard {
  private readonly ai = inject(AiService);
  private readonly toast = inject(ToastService);
  protected readonly s = signal<FollowThroughSettings | null>(null);
  protected readonly mail = signal(true);
  protected readonly busy = signal(false);
  protected webhook = '';

  constructor() {
    void this.ai.followThrough().then(
      (r) => this.apply(r),
      () => {},
    );
  }

  private apply(r: { settings: FollowThroughSettings; mail: boolean }): void {
    this.s.set(r.settings);
    this.mail.set(r.mail);
    this.webhook = r.settings.webhookUrl ?? '';
  }

  protected async save(patch: Partial<FollowThroughSettings>): Promise<void> {
    this.busy.set(true);
    try {
      this.apply(await this.ai.saveFollowThrough(patch));
      this.toast.show('Saved');
    } catch (err) {
      this.toast.error(apiErrorMessage(err, 'Could not save.'));
    } finally {
      this.busy.set(false);
    }
  }
}
