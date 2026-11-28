import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { DatePipe } from '@angular/common';
import { AiService, type Feedback } from '../../core/ai.service';
import { apiErrorMessage } from '../../core/auth.service';
import { ToastService } from '../../shared/toast';

/** Self-improving notes: corrections people made, the recurring mistakes, and the lessons the note-taker now follows. */
@Component({
  selector: 'app-notes-learning',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [DatePipe],
  template: `
    <h2>Learning from corrections</h2>
    <p class="hint">
      Every fix to the AI notes of your meetings (a wrong owner, deadline, speaker or decision status, an item it shouldn't have
      noted or one it missed) is kept as an example. The AI turns recurring mistakes into lessons it follows in every meeting.
    </p>
    @if (f(); as f) {
      @if (f.total === 0) {
        <p class="hint">No corrections yet.</p>
      } @else {
        <h3 class="sub-h">Most corrected <span class="muted">({{ f.total }} corrections)</span></h3>
        <ul class="list">
          @for (m of f.mistakes.slice(0, 6); track $index) {
            <li><span>{{ mistakeLabel(m) }}</span><span class="muted">{{ m.count }}×</span></li>
          }
        </ul>

        <h3 class="sub-h">Lessons it follows
          @if (f.learnedAt) { <span class="muted">· updated {{ f.learnedAt | date: 'd MMM, HH:mm' }}</span> }
        </h3>
        @if (!f.lessons.length) {
          <p class="hint">None yet. Lessons are worked out from your corrections about once an hour.</p>
        }
        <ul class="list">
          @for (l of f.lessons; track l.text) {
            <li [class.off]="!l.active">
              <span>{{ l.text }} <span class="muted">· {{ l.support }} {{ l.support === 1 ? 'correction' : 'corrections' }}</span></span>
              <button type="button" class="link" [disabled]="busy()" (click)="toggle(l.text, !l.active)">{{ l.active ? 'Turn off' : 'Turn on' }}</button>
            </li>
          }
        </ul>
        <div class="actions">
          <a class="btn btn-outline" [href]="datasetUrl" download>Download dataset</a>
          @if (f.canLearn) {
            <button class="btn btn-outline" type="button" [disabled]="busy()" (click)="relearn()">
              @if (busy()) { <span class="spinner"></span> } Learn now
            </button>
          }
          <button class="btn btn-outline" type="button" [disabled]="busy()" (click)="reset()">Forget all</button>
        </div>
      }
    } @else {
      <p class="hint">Loading…</p>
    }
  `,
  styles: `
    :host { display: block; }
    h2 { margin: 0 0 18px; font-size: 18px; font-weight: 600; }
    .hint { margin: -6px 0 16px; color: var(--text-muted); font-size: 14px; line-height: 1.5; }
    .sub-h { margin: 20px 0 8px; font-size: 15px; font-weight: 600; }
    .muted { color: var(--text-muted); font-weight: 400; font-size: 13px; }
    .list { list-style: none; margin: 0 0 8px; padding: 0;
      li { display: flex; justify-content: space-between; gap: 12px; padding: 8px 0; border-bottom: 1px solid #222; font-size: 14px; line-height: 1.45; }
      li.off > span { color: var(--text-muted); text-decoration: line-through; } }
    .link { flex: none; background: none; border: none; padding: 0; color: var(--link); font-size: 13px; cursor: pointer; }
    .actions { display: flex; flex-wrap: wrap; gap: 10px; justify-content: flex-end; margin-top: 14px;
      .btn { width: auto; min-width: 120px; height: 40px; font-size: 14px; display: inline-flex; align-items: center; justify-content: center; gap: 6px; } }
  `,
})
export class NotesLearning {
  private readonly ai = inject(AiService);
  private readonly toast = inject(ToastService);
  protected readonly f = signal<Feedback | null>(null);
  protected readonly busy = signal(false);
  protected readonly datasetUrl = this.ai.feedbackDatasetUrl;

  constructor() {
    void this.ai.feedback().then(
      (f) => this.f.set(f),
      () => {},
    );
  }

  protected mistakeLabel(m: Feedback['mistakes'][number]): string {
    const what = { decision: 'decision', task: 'task', question: 'question', speaker: 'speaker' }[m.kind] ?? m.kind;
    if (m.action === 'delete') return `Noted a ${what} that shouldn't be there`;
    if (m.action === 'add') return `Missed a ${what}`;
    if (m.kind === 'speaker') return 'Wrong speaker';
    const field = { owner: 'owner', dueDate: 'due date', status: 'status', statement: 'wording', task: 'wording' }[m.field ?? ''] ?? m.field;
    return `Wrong ${what} ${field}`;
  }

  private async run(fn: () => Promise<Feedback>, done: string): Promise<void> {
    this.busy.set(true);
    try {
      this.f.set(await fn());
      this.toast.show(done);
    } catch (err) {
      this.toast.error(apiErrorMessage(err, 'That did not work.'));
    } finally {
      this.busy.set(false);
    }
  }

  protected toggle(text: string, active: boolean): Promise<void> {
    return this.run(() => this.ai.toggleLesson(text, active), active ? 'Lesson turned on' : 'Lesson turned off');
  }

  protected relearn(): Promise<void> {
    return this.run(() => this.ai.relearn(), 'Lessons updated');
  }

  protected reset(): Promise<void> {
    return this.run(async () => {
      await this.ai.resetFeedback();
      return this.ai.feedback();
    }, 'Corrections and lessons deleted');
  }
}
