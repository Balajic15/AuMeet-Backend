import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { DatePipe, NgTemplateOutlet } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { AiService, type CorrectionBrief, type Feedback, type LearningPolicy, type Lesson } from '../../core/ai.service';
import { apiErrorMessage } from '../../core/auth.service';
import { ToastService } from '../../shared/toast';

const POLICY_FIELDS: Array<{ key: keyof LearningPolicy; label: string; step: number; min: number; max: number }> = [
  { key: 'minCorrections', label: 'Corrections needed', step: 1, min: 1, max: 100 },
  { key: 'minSessions', label: '…from at least this many meetings', step: 1, min: 1, max: 50 },
  { key: 'minPeople', label: '…by at least this many people', step: 1, min: 1, max: 20 },
  { key: 'minConfidence', label: 'Minimum confidence (0–1)', step: 0.05, min: 0, max: 1 },
  { key: 'windowDays', label: 'Only count corrections from the last … days', step: 1, min: 1, max: 3650 },
];

/**
 * Safe self-improvement: corrections become lessons only with enough independent evidence; every change is a
 * version that can be rolled back; any single correction can be marked wrong.
 */
@Component({
  selector: 'app-notes-learning',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [DatePipe, FormsModule, NgTemplateOutlet],
  template: `
    <h2>Learning from corrections</h2>
    <p class="hint">
      Fixes to the AI notes of your meetings are kept as examples. A recurring mistake becomes a lesson the AI follows,
      but only with enough independent evidence, so one wrong correction can't turn into a rule. Every change is saved
      as a version you can roll back.
    </p>
    @if (f(); as f) {
      @if (f.total === 0 && !f.versions.length) {
        <p class="hint">No corrections yet.</p>
      } @else {
        <p class="meta">
          {{ f.total }} corrections
          @if (f.excluded) { · {{ f.excluded }} marked wrong }
          @if (f.quarantined) { · {{ f.quarantined }} set aside by a rollback }
          @if (f.current) { · version {{ f.current }} }
          @if (f.learnedAt) { · checked {{ f.learnedAt | date: 'd MMM, HH:mm' }} }
        </p>

        <h3 class="sub-h">Applied in your meetings <span class="n">{{ applied().length }}</span></h3>
        @if (!applied().length) { <p class="hint">None yet.</p> }
        @for (l of applied(); track l.id) { <ng-container *ngTemplateOutlet="row; context: { $implicit: l }" /> }

        @if (waiting().length) {
          <h3 class="sub-h">Waiting for more evidence <span class="n">{{ waiting().length }}</span></h3>
          <p class="hint">Not used until they meet your thresholds below.</p>
          @for (l of waiting(); track l.id) { <ng-container *ngTemplateOutlet="row; context: { $implicit: l }" /> }
        }
        @if (off().length) {
          <h3 class="sub-h">Switched off</h3>
          @for (l of off(); track l.id) { <ng-container *ngTemplateOutlet="row; context: { $implicit: l }" /> }
        }

        <ng-template #row let-l>
          <div class="lesson" [class]="'lesson s-' + l.status">
            <div class="l-head">
              <span class="l-text">{{ l.text }}</span>
              <button type="button" class="link" [disabled]="busy()" (click)="toggle(l)">{{ l.status === 'off' ? 'Turn on' : 'Turn off' }}</button>
            </div>
            <p class="l-meta">
              {{ l.support.corrections }} {{ l.support.corrections === 1 ? 'correction' : 'corrections' }} ·
              {{ l.support.sessions }} {{ l.support.sessions === 1 ? 'meeting' : 'meetings' }} ·
              {{ l.support.people }} {{ l.support.people === 1 ? 'person' : 'people' }} ·
              confidence {{ l.confidence }}
              @if (l.status !== 'active') { <br /><span class="why">{{ l.reason }}</span> }
            </p>
            <button type="button" class="link small" (click)="expand(l.id)">{{ open() === l.id ? 'Hide' : 'Show' }} the corrections behind it</button>
            @if (open() === l.id) {
              <ul class="ev">
                @for (c of l.evidenceDetail; track c.id) {
                  <li [class.excluded]="c.excluded">
                    <span>{{ describe(c) }} <span class="muted">· {{ c.at | date: 'd MMM' }}</span></span>
                    <button type="button" class="link small" [disabled]="busy()" (click)="exclude(c)">{{ c.excluded ? 'Count it again' : 'This correction was wrong' }}</button>
                  </li>
                }
                @for (c of l.contradictedDetail; track c.id) {
                  <li class="against"><span>Against it: {{ describe(c) }}</span></li>
                }
              </ul>
            }
          </div>
        </ng-template>

        @if (f.versions.length > 1) {
          <h3 class="sub-h">History</h3>
          <ul class="versions">
            @for (v of f.versions; track v.version) {
              <li [class.cur]="v.version === f.current">
                <div>
                  <strong>v{{ v.version }}</strong> <span class="muted">{{ v.createdAt | date: 'd MMM, HH:mm' }} · {{ sourceLabel(v.source) }}</span>
                  <div class="muted small-t">{{ v.note }} · {{ v.active }} applied, {{ v.candidates }} waiting</div>
                </div>
                @if (v.version === f.current) {
                  <span class="muted">current</span>
                } @else {
                  <button type="button" class="link" [disabled]="busy()" (click)="rollback(v.version)">Restore</button>
                }
              </li>
            }
          </ul>
        }

        <h3 class="sub-h">Thresholds</h3>
        <div class="policy">
          @for (p of policyFields; track p.key) {
            <label>
              <span>{{ p.label }}</span>
              <input class="input" type="number" [step]="p.step" [min]="p.min" [max]="p.max" [(ngModel)]="draft[p.key]" />
            </label>
          }
        </div>

        <div class="actions">
          <a class="btn btn-outline" [href]="datasetUrl" download>Download dataset</a>
          <button class="btn btn-outline" type="button" [disabled]="busy() || !policyDirty()" (click)="savePolicy()">Save thresholds</button>
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
    .hint { margin: -4px 0 14px; color: var(--text-muted); font-size: 14px; line-height: 1.5; }
    .meta { margin: 0 0 6px; color: var(--text-muted); font-size: 13px; }
    .sub-h { display: flex; align-items: center; gap: 8px; margin: 22px 0 10px; font-size: 15px; font-weight: 600; }
    .n { padding: 0 7px; border-radius: 99px; background: #2a2a2a; font-size: 11.5px; font-weight: 500; }
    .muted { color: var(--text-muted); font-weight: 400; font-size: 13px; }
    .lesson { padding: 10px 12px; margin-bottom: 8px; background: var(--surface-sunken); border: 1px solid #262626; border-left: 3px solid var(--brand); }
    .lesson.s-candidate { border-left-color: #666; }
    .lesson.s-off { border-left-color: #333; opacity: 0.6; }
    .l-head { display: flex; justify-content: space-between; gap: 12px; }
    .l-text { font-size: 14.5px; line-height: 1.45; }
    .l-meta { margin: 6px 0 4px; color: var(--text-muted); font-size: 12.5px; line-height: 1.5; }
    .why { color: #ffcf73; }
    .link { flex: none; background: none; border: none; padding: 0; color: var(--link); font-size: 13px; cursor: pointer; }
    .link.small { font-size: 12.5px; }
    .ev { list-style: none; margin: 8px 0 0; padding: 0 0 0 10px; border-left: 2px solid #333;
      li { display: flex; justify-content: space-between; gap: 10px; flex-wrap: wrap; padding: 5px 0; font-size: 13px; line-height: 1.45; }
      li.excluded > span { text-decoration: line-through; color: var(--text-muted); }
      li.against { color: #ffcf73; } }
    .versions { list-style: none; margin: 0; padding: 0;
      li { display: flex; justify-content: space-between; align-items: center; gap: 12px; padding: 8px 0; border-bottom: 1px solid #222; font-size: 14px; }
      li.cur strong { color: var(--brand); } }
    .small-t { font-size: 12.5px; margin-top: 2px; }
    .policy { display: grid; gap: 8px;
      label { display: flex; justify-content: space-between; align-items: center; gap: 12px; font-size: 14px; }
      .input { width: 110px; height: 38px; } }
    .actions { display: flex; flex-wrap: wrap; gap: 10px; justify-content: flex-end; margin-top: 18px;
      .btn { width: auto; min-width: 120px; height: 40px; font-size: 14px; display: inline-flex; align-items: center; justify-content: center; gap: 6px; } }
  `,
})
export class NotesLearning {
  private readonly ai = inject(AiService);
  private readonly toast = inject(ToastService);
  protected readonly f = signal<Feedback | null>(null);
  protected readonly busy = signal(false);
  protected readonly open = signal<string | null>(null);
  protected readonly datasetUrl = this.ai.feedbackDatasetUrl;
  protected readonly policyFields = POLICY_FIELDS;
  protected draft: Partial<LearningPolicy> = {};

  protected readonly applied = computed(() => this.f()?.lessons.filter((l) => l.status === 'active') ?? []);
  protected readonly waiting = computed(() => this.f()?.lessons.filter((l) => l.status === 'candidate') ?? []);
  protected readonly off = computed(() => this.f()?.lessons.filter((l) => l.status === 'off') ?? []);
  /** Plain method: the draft is edited through ngModel, which re-runs change detection. */
  protected policyDirty(): boolean {
    const eff = this.f()?.policy.effective;
    return !!eff && POLICY_FIELDS.some((p) => this.draft[p.key] !== undefined && Number(this.draft[p.key]) !== eff[p.key]);
  }

  constructor() {
    void this.ai.feedback().then(
      (f) => this.apply(f),
      () => {},
    );
  }

  private apply(f: Feedback): void {
    this.f.set(f);
    this.draft = { ...f.policy.effective };
  }

  protected expand(id: string): void {
    this.open.set(this.open() === id ? null : id);
  }

  protected describe(c: CorrectionBrief): string {
    const v = (x: unknown) => (x === null || x === undefined || x === '' ? 'nothing' : typeof x === 'object' ? Object.values(x as object).filter(Boolean).join(', ') : String(x));
    if (c.action === 'delete') return `Removed a ${c.kind}: ${v(c.before)}`;
    if (c.action === 'add') return `Added a missed ${c.kind}: ${v(c.after)}`;
    return `${c.kind} ${c.field ?? ''}: ${v(c.before)} → ${v(c.after)}`;
  }

  protected sourceLabel(s: string): string {
    return { learn: 'learned', rollback: 'rollback', toggle: 'lesson switched', exclude: 'correction marked', policy: 'thresholds changed' }[s] ?? s;
  }

  private async run(fn: () => Promise<Feedback>, done: string): Promise<void> {
    this.busy.set(true);
    try {
      this.apply(await fn());
      this.toast.show(done);
    } catch (err) {
      this.toast.error(apiErrorMessage(err, 'That did not work.'));
    } finally {
      this.busy.set(false);
    }
  }

  protected toggle(l: Lesson): Promise<void> {
    const on = l.status === 'off';
    return this.run(() => this.ai.toggleLesson(l.id, on), on ? 'Lesson turned on' : 'Lesson turned off');
  }

  protected exclude(c: CorrectionBrief): Promise<void> {
    return this.run(() => this.ai.excludeCorrection(c.id, !c.excluded), c.excluded ? 'Counted again' : 'Correction set aside; lessons re-checked');
  }

  protected rollback(version: number): Promise<void> {
    return this.run(() => this.ai.rollbackLessons(version), `Restored version ${version}`);
  }

  protected savePolicy(): Promise<void> {
    const eff = this.f()?.policy.effective;
    if (!eff) return Promise.resolve();
    const patch: Partial<LearningPolicy> = {};
    for (const p of POLICY_FIELDS) {
      const n = Number(this.draft[p.key]);
      if (Number.isFinite(n) && n !== eff[p.key]) patch[p.key] = n;
    }
    return this.run(() => this.ai.saveLearningPolicy(patch), 'Thresholds saved; lessons re-checked');
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
