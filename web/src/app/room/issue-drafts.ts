import { ChangeDetectionStrategy, Component, computed, inject, input, signal } from '@angular/core';
import { HttpClient, HttpErrorResponse } from '@angular/common/http';
import { firstValueFrom } from 'rxjs';
import { apiErrorMessage } from '../core/auth.service';
import type { IssueDraftView } from '../core/insights';
import { Icon } from '../shared/icon';
import { ToastService } from '../shared/toast';

const FIELD_LABELS: Array<[string, string]> = [
  ['description', 'Description'],
  ['userRole', 'User'],
  ['goal', 'Wants to'],
  ['benefit', 'So that'],
  ['stepsToReproduce', 'Steps to reproduce'],
  ['expected', 'Expected'],
  ['actual', 'Actual'],
  ['environment', 'Environment'],
  ['severity', 'Severity'],
  ['priority', 'Priority'],
  ['component', 'Component'],
  ['assignee', 'Assignee'],
  ['acceptanceCriteria', 'Acceptance criteria'],
  ['labels', 'Labels'],
];

/** Live preview of the Jira tickets the AI is preparing in this meeting; approve, cancel or attach files. */
@Component({
  selector: 'app-issue-drafts',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [Icon],
  template: `
    @for (d of shown(); track d.id) {
      <article class="ticket" [class]="'ticket s-' + d.status">
        <div class="head">
          <span class="type">{{ typeLabel(d.type) }}</span>
          <span class="status">{{ statusLabel(d) }}</span>
        </div>
        <p class="summary">{{ d.fields.summary || 'Untitled – the AI is still gathering details' }}</p>
        @if (d.jira; as j) {
          <a class="jira" [href]="j.url" target="_blank" rel="noopener"><app-icon name="link" [size]="13" /> {{ j.key }} – open in Jira</a>
        }
        <dl>
          @for (f of fields(d); track f[0]) {
            <dt>{{ f[0] }}</dt>
            <dd>
              @if (isList(f[1])) { <ol>@for (x of asList(f[1]); track $index) { <li>{{ x }}</li> }</ol> } @else { {{ f[1] }} }
            </dd>
          }
        </dl>
        @if (d.missing.length && !d.jira) {
          <p class="missing"><app-icon name="alert" [size]="13" /> Still needed: {{ d.missing.join(', ') }}</p>
        }
        @if (d.evidence.attachments.length) {
          <ul class="att">
            @for (a of d.evidence.attachments; track a.id) {
              <li>
                <app-icon [name]="a.kind === 'recording' ? 'monitor' : a.kind === 'screenshot' ? 'monitor' : 'download'" [size]="13" />
                @if (a.kind === 'screenshot' || a.kind === 'file') {
                  <a [href]="attachmentUrl(d, a.id)" target="_blank" rel="noopener">{{ a.name }}</a>
                } @else { {{ a.name }} }
                <span class="muted">{{ attachmentStatus(a.status) }}</span>
              </li>
            }
          </ul>
        } @else if (d.evidence.decision === 'none') {
          <p class="muted">No attachment</p>
        } @else if (d.evidence.decision === 'later') {
          <p class="muted">Attachments will be added later</p>
        }
        @if (d.duplicateOf && !d.jira) {
          <p class="missing">Looks like <a [href]="d.duplicateOf.url" target="_blank" rel="noopener">{{ d.duplicateOf.key }}</a>: {{ d.duplicateOf.summary }}</p>
        }
        @if (d.error && d.status === 'failed') { <p class="err">{{ d.error }}</p> }
        @if (!d.jira && d.status !== 'cancelled') {
          <div class="btns">
            <label class="btn btn-outline small file">
              <input type="file" (change)="attach(d, $event)" [disabled]="busy()" /> Attach file
            </label>
            <button type="button" class="btn btn-outline small" [disabled]="busy()" (click)="cancel(d)">Cancel</button>
            @if (dupeFor() === d.id) {
              <button type="button" class="btn btn-primary small" [disabled]="busy()" (click)="create(d, true)">Create anyway</button>
            } @else {
              <button type="button" class="btn btn-primary small" [disabled]="busy() || d.status === 'creating'" (click)="create(d, false)">Create in Jira</button>
            }
          </div>
        }
      </article>
    }
  `,
  styles: `
    :host { display: block; margin-bottom: 18px; }
    .ticket { padding: 12px 14px; margin-bottom: 10px; background: var(--surface-sunken); border: 1px solid #262626; border-left: 3px solid #2684ff; }
    .ticket.s-created { border-left-color: var(--brand); }
    .ticket.s-failed { border-left-color: var(--danger); }
    .head { display: flex; justify-content: space-between; gap: 8px; font-size: 12px; }
    .type { font-weight: 600; color: #8fb8ff; text-transform: uppercase; letter-spacing: 0.04em; }
    .status { color: var(--text-muted); }
    .summary { margin: 6px 0 8px; font-size: 14.5px; font-weight: 500; line-height: 1.4; }
    .jira { display: inline-flex; align-items: center; gap: 4px; font-size: 13px; margin-bottom: 6px; }
    dl { margin: 0; font-size: 13px; line-height: 1.45; }
    dt { color: var(--text-muted); font-size: 11.5px; text-transform: uppercase; letter-spacing: 0.03em; margin-top: 6px; }
    dd { margin: 1px 0 0; ol { margin: 0; padding-left: 18px; } }
    .missing { display: flex; gap: 6px; align-items: flex-start; margin: 8px 0 0; color: #ffcf73; font-size: 12.5px; }
    .att { list-style: none; margin: 8px 0 0; padding: 0; font-size: 12.5px; li { display: flex; gap: 6px; align-items: center; margin: 3px 0; } }
    .muted { color: var(--text-muted); font-size: 12px; }
    .err { color: var(--danger); font-size: 12.5px; margin: 6px 0 0; }
    .btns { display: flex; flex-wrap: wrap; gap: 6px; justify-content: flex-end; margin-top: 10px; }
    .btn.small { width: auto; height: 30px; padding: 0 10px; font-size: 12.5px; display: inline-flex; align-items: center; }
    .file { position: relative; overflow: hidden; cursor: pointer; input { position: absolute; inset: 0; opacity: 0; cursor: pointer; } }
  `,
})
export class IssueDrafts {
  readonly code = input.required<string>();
  readonly drafts = input.required<IssueDraftView[]>();
  private readonly http = inject(HttpClient);
  private readonly toast = inject(ToastService);
  protected readonly busy = signal(false);
  protected readonly dupeFor = signal<string | null>(null);

  /** Open drafts and recently created issues (cancelled ones are hidden). */
  protected readonly shown = computed(() => this.drafts().filter((d) => d.status !== 'cancelled').slice(0, 5));

  protected fields(d: IssueDraftView): Array<[string, unknown]> {
    const f = d.fields as Record<string, unknown>;
    return FIELD_LABELS.filter(([k]) => (Array.isArray(f[k]) ? (f[k] as unknown[]).length : !!f[k])).map(([k, label]) => [label, f[k]]);
  }

  protected isList(v: unknown): boolean {
    return Array.isArray(v);
  }

  protected asList(v: unknown): string[] {
    return v as string[];
  }

  protected typeLabel(t: string): string {
    return ({ bug: 'Bug', story: 'User story', task: 'Task' } as Record<string, string>)[t] ?? t;
  }

  protected statusLabel(d: IssueDraftView): string {
    return ({ drafting: 'Draft', ready: 'Ready for approval', creating: 'Creating…', created: 'Created', failed: 'Not created', cancelled: 'Cancelled' } as Record<string, string>)[d.status] ?? d.status;
  }

  protected attachmentStatus(s: string): string {
    return ({ pending: 'recording…', ready: '', uploaded: 'attached', failed: 'too large / failed' } as Record<string, string>)[s] ?? '';
  }

  protected attachmentUrl(d: IssueDraftView, id: string): string {
    return `/api/meetings/${this.code()}/issues/${encodeURIComponent(d.id)}/attachments/${encodeURIComponent(id)}`;
  }

  protected async create(d: IssueDraftView, allowDuplicate: boolean): Promise<void> {
    this.busy.set(true);
    try {
      const r = await firstValueFrom(
        this.http.post<{ draft: IssueDraftView; duplicates?: Array<{ key: string }> }>(`/api/meetings/${this.code()}/issues/${encodeURIComponent(d.id)}/create`, { allowDuplicate }),
      );
      if (r.duplicates?.length) {
        this.dupeFor.set(d.id);
        this.toast.show(`Looks like ${r.duplicates[0]!.key} already covers this – check it, or create anyway.`);
      } else if (r.draft.jira) {
        this.dupeFor.set(null);
        this.toast.show(`Created ${r.draft.jira.key} in Jira`);
      }
    } catch (err) {
      this.toast.error(err instanceof HttpErrorResponse && err.error?.message ? err.error.message : apiErrorMessage(err, 'Could not create the issue.'));
    } finally {
      this.busy.set(false);
    }
  }

  protected async cancel(d: IssueDraftView): Promise<void> {
    this.busy.set(true);
    try {
      await firstValueFrom(this.http.post(`/api/meetings/${this.code()}/issues/${encodeURIComponent(d.id)}/cancel`, {}));
    } catch (err) {
      this.toast.error(apiErrorMessage(err, 'Could not cancel.'));
    } finally {
      this.busy.set(false);
    }
  }

  protected async attach(d: IssueDraftView, e: Event): Promise<void> {
    const input = e.target as HTMLInputElement;
    const file = input.files?.[0];
    input.value = '';
    if (!file) return;
    if (file.size > 10 * 1024 * 1024) {
      this.toast.error('Attachments can be at most 10 MB.');
      return;
    }
    const form = new FormData();
    form.append('file', file);
    this.busy.set(true);
    try {
      await firstValueFrom(this.http.post(`/api/meetings/${this.code()}/issues/${encodeURIComponent(d.id)}/attachments`, form));
      this.toast.show(`Attached ${file.name}`);
    } catch (err) {
      this.toast.error(apiErrorMessage(err, 'Could not attach the file.'));
    } finally {
      this.busy.set(false);
    }
  }
}
