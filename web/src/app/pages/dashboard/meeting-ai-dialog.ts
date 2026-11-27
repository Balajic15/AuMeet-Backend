import { ChangeDetectionStrategy, Component, OnInit, computed, inject, input, output, signal } from '@angular/core';
import { apiErrorMessage } from '../../core/auth.service';
import { AiService, behaviourDiff, type Behaviour } from '../../core/ai.service';
import type { Meeting } from '../../core/meetings.service';
import { BehaviourEditor } from '../../shared/behaviour-editor';
import { Modal } from '../../shared/modal';
import { ToastService } from '../../shared/toast';

/** This meeting's AI behaviour, on top of the host's account default. Applies live if the meeting is running. */
@Component({
  selector: 'app-meeting-ai-dialog',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [Modal, BehaviourEditor],
  template: `
    <app-modal heading="AI in this meeting" (closed)="closed.emit()">
      <p class="intro">
        {{ customised() ? 'This meeting has its own settings.' : 'Using your account default.' }}
        Changes apply right away, even during the meeting.
      </p>
      @if (error()) { <div class="alert">{{ error() }}</div> }
      @if (draft(); as d) {
        <app-behaviour-editor [value]="d" (changed)="draft.set($event)" />
        <div class="dlg-actions">
          <button type="button" class="btn btn-outline" [disabled]="saving() || !customised()" (click)="useDefault()">Use my default</button>
          <button type="button" class="btn btn-primary" [disabled]="saving()" (click)="save()">
            @if (saving()) { <span class="spinner"></span> } Save
          </button>
        </div>
      } @else {
        <p class="intro">Loading…</p>
      }
    </app-modal>
  `,
  styles: `
    .intro { margin: -6px 0 18px; color: var(--text-muted); font-size: 14px; line-height: 1.5; }
    .dlg-actions { display: flex; justify-content: flex-end; gap: 12px; margin-top: 16px; flex-wrap: wrap;
      .btn { width: auto; min-width: 120px; height: 44px; font-size: 15px; } }
  `,
})
export class MeetingAiDialog implements OnInit {
  private readonly ai = inject(AiService);
  private readonly toast = inject(ToastService);

  readonly meeting = input.required<Meeting>();
  readonly closed = output<void>();

  private readonly base = signal<Behaviour | null>(null);
  protected readonly draft = signal<Behaviour | null>(null);
  protected readonly saving = signal(false);
  protected readonly error = signal<string | null>(null);
  protected readonly customised = computed(() => {
    const d = this.draft();
    const b = this.base();
    return !!d && !!b && Object.keys(behaviourDiff(d, b)).length > 0;
  });

  ngOnInit(): void {
    void this.ai.meeting(this.meeting().code).then(
      (r) => {
        this.base.set(r.account);
        this.draft.set(r.effective);
      },
      (err) => this.error.set(apiErrorMessage(err, 'Could not load the AI settings.')),
    );
  }

  protected async save(): Promise<void> {
    const d = this.draft();
    const b = this.base();
    if (!d || !b) return;
    const diff = behaviourDiff(d, b);
    await this.persist(Object.keys(diff).length ? diff : null, 'AI settings saved for this meeting');
  }

  protected async useDefault(): Promise<void> {
    await this.persist(null, 'This meeting uses your default again');
    this.draft.set(this.base());
  }

  private async persist(override: ReturnType<typeof behaviourDiff> | null, done: string): Promise<void> {
    this.saving.set(true);
    this.error.set(null);
    try {
      await this.ai.saveMeeting(this.meeting().code, override, 'replace');
      this.toast.show(done);
      this.closed.emit();
    } catch (err) {
      this.error.set(apiErrorMessage(err, 'Could not save.'));
    } finally {
      this.saving.set(false);
    }
  }
}
