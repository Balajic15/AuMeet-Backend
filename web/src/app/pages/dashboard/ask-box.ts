import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { apiErrorMessage } from '../../core/auth.service';
import { MemoryService, type AskResult } from '../../core/memory.service';
import { Icon } from '../../shared/icon';

const EXAMPLES = ['What did we decide about the database?', 'What tasks did I take on last week?', 'What is still unresolved?'];

/** "Ask your meetings" – questions answered from the user's own past meetings, with sources. */
@Component({
  selector: 'app-ask-box',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [Icon, RouterLink],
  template: `
    <section class="ask">
      <h2><app-icon name="sparkles" [size]="16" /> Ask your meetings</h2>
      <form (submit)="$event.preventDefault(); submit()">
        <input class="input" type="text" maxlength="500" placeholder="What did we decide about…"
               aria-label="Question about your past meetings" [value]="question()"
               (input)="question.set($any($event.target).value)" />
        <button type="submit" class="btn btn-outline go" [disabled]="loading() || question().trim().length < 3" aria-label="Ask">
          @if (loading()) { <span class="spinner"></span> } @else { <app-icon name="send" [size]="18" /> }
        </button>
      </form>

      @if (!result() && !error() && !loading()) {
        <div class="examples">
          @for (e of examples; track e) {
            <button type="button" (click)="question.set(e); submit()">{{ e }}</button>
          }
        </div>
      }

      @if (error()) { <p class="field-error err">{{ error() }}</p> }

      @if (result(); as r) {
        <div class="answer">
          <p>{{ r.answer }}</p>
          @if (r.sources.length) {
            <ul class="sources">
              @for (s of r.sources; track $index) {
                <li>
                  <a [routerLink]="['/', s.meetingCode, 'insights']">{{ s.meetingTitle }}</a>
                  <span class="when">{{ date(s.meetingDate) }} · {{ kindLabel(s.kind) }}</span>
                  <p class="excerpt">{{ s.excerpt }}</p>
                </li>
              }
            </ul>
          }
        </div>
      }
    </section>
  `,
  styles: `
    .ask { margin-top: 40px; padding-top: 28px; border-top: 1px solid #1f1f1f; }
    h2 { display: flex; align-items: center; gap: 8px; margin: 0 0 14px; font-size: 16px; font-weight: 600; color: var(--brand); }
    form { display: flex; gap: 10px; }
    .input { flex: 1; min-width: 0; font-size: 15px; }
    .go { width: 52px; padding: 0; flex: none; }
    .examples { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 12px; }
    .examples button {
      padding: 6px 10px; background: none; border: 1px solid #2c2c2c; color: var(--text-muted);
      font-size: 13px; cursor: pointer; text-align: left;
      &:hover { color: var(--text); border-color: var(--border-strong); }
    }
    .err { display: block; margin-top: 10px; }
    .answer { margin-top: 16px; padding: 16px; background: var(--surface); border: 1px solid #262626; }
    .answer > p { margin: 0; line-height: 1.55; font-size: 15px; }
    .sources { list-style: none; margin: 14px 0 0; padding: 12px 0 0; border-top: 1px solid #262626; display: grid; gap: 12px; }
    .sources a { font-size: 14px; font-weight: 500; }
    .when { margin-left: 8px; color: var(--text-muted); font-size: 12.5px; }
    .excerpt { margin: 4px 0 0; color: #bdbdbd; font-size: 13px; line-height: 1.45; white-space: pre-line;
      display: -webkit-box; -webkit-line-clamp: 3; -webkit-box-orient: vertical; overflow: hidden; }
  `,
})
export class AskBox {
  private readonly memory = inject(MemoryService);

  protected readonly examples = EXAMPLES;
  protected readonly question = signal('');
  protected readonly loading = signal(false);
  protected readonly result = signal<AskResult | null>(null);
  protected readonly error = signal<string | null>(null);

  protected async submit(): Promise<void> {
    const q = this.question().trim();
    if (q.length < 3 || this.loading()) return;
    this.loading.set(true);
    this.error.set(null);
    this.result.set(null);
    try {
      this.result.set(await this.memory.ask(q));
    } catch (err) {
      this.error.set(apiErrorMessage(err, 'Could not search your meetings right now.'));
    } finally {
      this.loading.set(false);
    }
  }

  protected date(d: string | null): string {
    return d ? new Date(d).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' }) : '';
  }

  protected kindLabel(k: string): string {
    return { recap: 'Recap', decision: 'Decision', task: 'Task', transcript: 'Discussion' }[k] ?? k;
  }
}
