import { ChangeDetectionStrategy, Component, OnInit, inject, input, output, signal } from '@angular/core';
import { apiErrorMessage } from '../../core/auth.service';
import {
  ACCEPTED_DOCUMENTS,
  MAX_DOCUMENT_MB,
  MeetingsService,
  type Meeting,
  type MeetingDocumentInfo,
} from '../../core/meetings.service';
import { Icon } from '../../shared/icon';
import { Modal } from '../../shared/modal';
import { ToastService } from '../../shared/toast';

interface Row {
  id?: string;
  title: string;
  minutes: string;
}

/**
 * Optional preparation for the AI: the meeting goal, a timed agenda, and documents it can read.
 * The AI keeps the meeting on track against these and answers from the documents.
 */
@Component({
  selector: 'app-prepare-dialog',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [Modal, Icon],
  template: `
    <app-modal heading="Prepare the meeting" (closed)="closed.emit()">
      <p class="intro">All optional. The AI uses these to answer questions and keep the meeting on track.</p>
      @if (error()) { <div class="alert">{{ error() }}</div> }

      <section>
        <label class="lbl" for="goal">Goal</label>
        <textarea id="goal" class="input area" rows="2" maxlength="1000"
                  placeholder="e.g. Decide the database and assign the migration tasks"
                  [value]="goal()" (input)="goal.set($any($event.target).value)"></textarea>
      </section>

      <section>
        <div class="lbl-row">
          <span class="lbl">Agenda</span>
          <span class="total">{{ totalMinutes() ? totalMinutes() + ' min planned' : '' }}</span>
        </div>
        @for (r of rows(); track $index; let i = $index) {
          <div class="agenda-row">
            <span class="num">{{ i + 1 }}</span>
            <input class="input" type="text" maxlength="200" placeholder="Item" [value]="r.title"
                   (input)="setRow(i, 'title', $any($event.target).value)" [attr.aria-label]="'Agenda item ' + (i + 1)" />
            <input class="input mins" type="number" min="1" max="600" placeholder="min" [value]="r.minutes"
                   (input)="setRow(i, 'minutes', $any($event.target).value)" aria-label="Minutes" />
            <button type="button" class="icon-btn" aria-label="Remove item" (click)="removeRow(i)">
              <app-icon name="x" [size]="16" />
            </button>
          </div>
        }
        @if (rows().length < 30) {
          <button type="button" class="link-btn" (click)="addRow()"><app-icon name="plus" [size]="14" /> Add agenda item</button>
        }
      </section>

      <section>
        <span class="lbl">Documents for the AI</span>
        <p class="hint">PDF, Word, PowerPoint, text or Markdown, up to {{ maxMb }} MB each. The AI reads the text; files aren't stored.</p>
        @if (docs().length) {
          <ul class="docs">
            @for (d of docs(); track d.id) {
              <li>
                <app-icon name="inbox" [size]="16" />
                <span class="doc-name" [title]="d.filename">{{ d.filename }}</span>
                <span class="doc-meta">{{ size(d.sizeBytes) }}@if (d.pages) { · {{ d.pages }} p }@if (d.truncated) { · long, partly read }</span>
                <button type="button" class="icon-btn danger" [attr.aria-label]="'Remove ' + d.filename" (click)="removeDoc(d)">
                  <app-icon name="trash" [size]="15" />
                </button>
              </li>
            }
          </ul>
        }
        <label class="upload" [class.busy]="uploading()">
          <input type="file" [accept]="accept" multiple (change)="upload($event)" [disabled]="uploading() || docs().length >= 10" />
          @if (uploading()) { <span class="spinner"></span> Reading {{ uploading() }}… } @else { <app-icon name="plus" [size]="16" /> Add files }
        </label>
      </section>

      <div class="dlg-actions">
        <button type="button" class="btn btn-outline" (click)="closed.emit()">Cancel</button>
        <button type="button" class="btn btn-primary" [disabled]="saving()" (click)="save()">
          @if (saving()) { <span class="spinner"></span> } Save
        </button>
      </div>
    </app-modal>
  `,
  styles: `
    .intro { margin: -6px 0 18px; color: var(--text-muted); font-size: 14px; line-height: 1.5; }
    section { margin-bottom: 22px; }
    .lbl { display: block; margin-bottom: 8px; font-weight: 600; font-size: 15px; }
    .lbl-row { display: flex; justify-content: space-between; align-items: baseline; }
    .total { color: var(--text-muted); font-size: 13px; }
    .input.area { height: auto; padding: 10px 14px; font-size: 15px; line-height: 1.5; resize: vertical; }
    .agenda-row { display: flex; align-items: center; gap: 8px; margin-bottom: 8px; }
    .agenda-row .input { height: 40px; font-size: 14.5px; }
    .agenda-row .mins { width: 76px; flex: none; }
    .num { width: 18px; flex: none; color: var(--text-muted); font-size: 13px; text-align: right; }
    .link-btn { display: inline-flex; align-items: center; gap: 6px; padding: 4px 0; background: none; border: none; color: var(--link); font-size: 14px; cursor: pointer; }
    .hint { margin: -2px 0 10px; color: var(--text-muted); font-size: 13px; }
    .docs { list-style: none; margin: 0 0 10px; padding: 0; }
    .docs li { display: flex; align-items: center; gap: 8px; padding: 8px 10px; border: 1px solid #262626; margin-bottom: 6px; font-size: 14px; }
    .doc-name { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .doc-meta { color: var(--text-muted); font-size: 12.5px; white-space: nowrap; }
    .icon-btn.danger:hover { color: var(--danger); }
    .upload {
      display: inline-flex; align-items: center; gap: 8px; padding: 9px 14px; border: 1px dashed var(--border-strong);
      font-size: 14px; cursor: pointer;
      input { display: none; }
      &:hover { border-color: var(--text-muted); }
      &.busy { cursor: progress; color: var(--text-muted); }
    }
    .dlg-actions { display: flex; justify-content: flex-end; gap: 12px; margin-top: 8px;
      .btn { width: auto; min-width: 110px; height: 44px; font-size: 15px; } }
    @media (max-width: 520px) { .agenda-row .mins { width: 64px; } }
  `,
})
export class PrepareDialog implements OnInit {
  private readonly meetings = inject(MeetingsService);
  private readonly toast = inject(ToastService);

  readonly meeting = input.required<Meeting>();
  readonly saved = output<Meeting>();
  readonly closed = output<void>();

  protected readonly accept = ACCEPTED_DOCUMENTS;
  protected readonly maxMb = MAX_DOCUMENT_MB;
  protected readonly goal = signal('');
  protected readonly rows = signal<Row[]>([]);
  protected readonly docs = signal<MeetingDocumentInfo[]>([]);
  protected readonly uploading = signal<string | null>(null);
  protected readonly saving = signal(false);
  protected readonly error = signal<string | null>(null);

  protected totalMinutes(): number {
    return this.rows().reduce((s, r) => s + (Number(r.minutes) || 0), 0);
  }

  ngOnInit(): void {
    const m = this.meeting();
    this.goal.set(m.prep?.goal ?? '');
    const agenda = m.prep?.agenda ?? [];
    this.rows.set(agenda.length ? agenda.map((a) => ({ id: a.id, title: a.title, minutes: a.minutes ? String(a.minutes) : '' })) : [{ title: '', minutes: '' }]);
    void this.meetings.documents(m.code).then((d) => this.docs.set(d), () => this.docs.set([]));
  }

  protected setRow(i: number, key: 'title' | 'minutes', value: string): void {
    this.rows.update((rs) => rs.map((r, j) => (j === i ? { ...r, [key]: value } : r)));
  }

  protected addRow(): void {
    this.rows.update((rs) => [...rs, { title: '', minutes: '' }]);
  }

  protected removeRow(i: number): void {
    this.rows.update((rs) => rs.filter((_, j) => j !== i));
  }

  protected async upload(e: Event): Promise<void> {
    const input = e.target as HTMLInputElement;
    const files = Array.from(input.files ?? []);
    input.value = '';
    this.error.set(null);
    for (const f of files) {
      if (this.docs().length >= 10) {
        this.error.set('A meeting can have up to 10 documents.');
        break;
      }
      if (f.size > MAX_DOCUMENT_MB * 1024 * 1024) {
        this.error.set(`"${f.name}" is larger than ${MAX_DOCUMENT_MB} MB.`);
        continue;
      }
      this.uploading.set(f.name);
      try {
        const doc = await this.meetings.uploadDocument(this.meeting().code, f);
        this.docs.update((d) => [...d, doc]);
      } catch (err) {
        this.error.set(apiErrorMessage(err, `Couldn't read "${f.name}".`));
      } finally {
        this.uploading.set(null);
      }
    }
  }

  protected async removeDoc(d: MeetingDocumentInfo): Promise<void> {
    try {
      await this.meetings.deleteDocument(this.meeting().code, d.id);
      this.docs.update((list) => list.filter((x) => x.id !== d.id));
    } catch (err) {
      this.error.set(apiErrorMessage(err, 'Could not remove the document.'));
    }
  }

  protected async save(): Promise<void> {
    const agenda = this.rows()
      .filter((r) => r.title.trim())
      .map((r) => {
        const minutes = Math.round(Number(r.minutes));
        return { ...(r.id ? { id: r.id } : {}), title: r.title.trim(), minutes: minutes >= 1 && minutes <= 600 ? minutes : null };
      });
    this.saving.set(true);
    this.error.set(null);
    try {
      const updated = await this.meetings.update(this.meeting().code, { prep: { goal: this.goal().trim(), agenda } });
      this.toast.show('Meeting prepared');
      this.saved.emit(updated);
    } catch (err) {
      this.error.set(apiErrorMessage(err, 'Could not save.'));
    } finally {
      this.saving.set(false);
    }
  }

  protected size(bytes: number): string {
    return bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;
  }
}
