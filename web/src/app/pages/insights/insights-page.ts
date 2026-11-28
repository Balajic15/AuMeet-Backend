import { ChangeDetectionStrategy, Component, computed, effect, inject, input, signal, untracked } from '@angular/core';
import { HttpErrorResponse } from '@angular/common/http';
import { FormsModule } from '@angular/forms';
import { Title } from '@angular/platform-browser';
import { RouterLink } from '@angular/router';
import { apiErrorMessage } from '../../core/auth.service';
import {
  InsightsService,
  isEmptyInsights,
  type ActionItem,
  type Decision,
  type DecisionStatus,
  type InsightSession,
  type TranscriptLine,
} from '../../core/insights';
import { MeetingsService, type Meeting, type RecordingInfo } from '../../core/meetings.service';
import { Icon } from '../../shared/icon';
import { InsightsView } from '../../shared/insights-view';
import { Modal } from '../../shared/modal';
import { ToastService } from '../../shared/toast';
import { UserMenu } from '../../shared/user-menu';
import { AuthService } from '../../core/auth.service';
import { FollowThroughPanel } from './follow-through-panel';
import { SessionAnalytics } from './session-analytics';

type View = 'notes' | 'transcript' | 'analytics' | 'follow';

/** AI notes for one meeting: recap, decisions/tasks/questions (editable after the meeting), transcript. */
@Component({
  selector: 'app-insights-page',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [Icon, InsightsView, RouterLink, UserMenu, Modal, FormsModule, FollowThroughPanel, SessionAnalytics],
  templateUrl: './insights-page.html',
  styleUrl: './insights-page.scss',
})
export class InsightsPage {
  readonly code = input.required<string>();

  private readonly api = inject(InsightsService);
  private readonly title = inject(Title);
  private readonly toast = inject(ToastService);
  private readonly meetingsApi = inject(MeetingsService);
  private readonly auth = inject(AuthService);
  protected readonly recordings = signal<RecordingInfo[]>([]);

  protected readonly loading = signal(true);
  protected readonly error = signal<string | null>(null);
  protected readonly meeting = signal<Meeting | null>(null);
  protected readonly sessions = signal<InsightSession[]>([]);
  protected readonly selected = signal<string | null>(null);
  protected readonly lines = signal<TranscriptLine[]>([]);
  protected readonly view = signal<View>('notes');
  protected readonly isEmpty = isEmptyInsights;

  // editing
  protected readonly editingDecision = signal<Decision | null>(null);
  protected readonly editingTask = signal<ActionItem | null>(null);
  protected readonly saving = signal(false);
  protected decisionDraft = { statement: '', status: 'proposed' as DecisionStatus };
  protected taskDraft = { task: '', owner: '', dueDate: '', status: 'open' as 'open' | 'done' };

  /** Adding what the AI missed / fixing a speaker. */
  protected readonly adding = signal<'task' | 'decision' | null>(null);
  protected addTaskDraft = { task: '', owner: '', dueDate: '' };
  protected addDecisionDraft = { statement: '', status: 'agreed' as DecisionStatus };
  protected readonly fixing = signal<TranscriptLine | null>(null);
  protected speakerDraft = { to: '', all: false };
  protected readonly isHost = computed(() => !!this.meeting() && this.meeting()!.hostId === this.auth.user()?.id);
  protected readonly speakers = computed(() => [
    ...new Set([...(this.session()?.participants ?? []), ...this.lines().filter((l) => !l.isAgent).map((l) => l.speakerName)]),
  ]);

  protected readonly session = computed(() => this.sessions().find((s) => s.sessionId === this.selected()) ?? null);
  /** Notes become editable once the live note-taker is done with them. */
  protected readonly editable = computed(() => !!this.session()?.endedAt);
  protected readonly downloadUrl = computed(() => {
    const s = this.session();
    return s ? this.api.transcriptDownloadUrl(this.code(), s.sessionId) : '';
  });

  protected readonly statuses: { value: DecisionStatus; label: string }[] = [
    { value: 'agreed', label: 'Confirmed decision' },
    { value: 'proposed', label: 'Suggested (not settled)' },
    { value: 'disputed', label: 'Needs confirmation' },
    { value: 'rejected', label: 'Dropped' },
  ];

  constructor() {
    effect(() => {
      const code = this.code();
      untracked(() => void this.load(code));
    });
  }

  private async load(code: string, keepSelection = false): Promise<void> {
    if (!keepSelection) this.loading.set(true);
    this.error.set(null);
    try {
      const res = await this.api.get(code);
      this.meeting.set(res.meeting);
      this.sessions.set(res.sessions);
      this.title.setTitle(`Notes · ${res.meeting.title} · AuMeet`);
      void this.meetingsApi.recordings(code).then((r) => this.recordings.set(r), () => this.recordings.set([]));
      if (keepSelection && this.session()) return;
      // Prefer the newest session that actually has notes.
      const first = res.sessions.find((s) => !isEmptyInsights(s.insights)) ?? res.sessions[0];
      if (first) await this.select(first.sessionId);
    } catch (err) {
      this.error.set(
        err instanceof HttpErrorResponse && err.status === 404
          ? 'Meeting not found.'
          : apiErrorMessage(err, 'Could not load the meeting notes.'),
      );
    } finally {
      this.loading.set(false);
    }
  }

  protected async select(sessionId: string): Promise<void> {
    this.selected.set(sessionId);
    this.lines.set([]);
    try {
      this.lines.set(await this.api.transcript(this.code(), sessionId));
    } catch {
      /* sources are optional */
    }
  }

  protected when(s: InsightSession): string {
    const d = s.startedAt ? new Date(s.startedAt) : null;
    return d
      ? d.toLocaleString(undefined, { weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' })
      : 'Session';
  }

  protected time(at: string): string {
    return new Date(at).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  }

  protected recordingUrl(id: string): string {
    return this.meetingsApi.recordingDownloadUrl(this.code(), id);
  }

  protected recordingLabel(r: RecordingInfo): string {
    const when = new Date(r.startedAt).toLocaleString(undefined, { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' });
    const mins = r.durationSec ? ` · ${Math.max(1, Math.round(r.durationSec / 60))} min` : '';
    return when + mins;
  }

  // ---------- editing ----------

  protected openDecision(d: Decision): void {
    this.decisionDraft = { statement: d.statement, status: d.status };
    this.editingDecision.set(d);
  }

  protected openTask(a: ActionItem): void {
    this.taskDraft = { task: a.task, owner: a.owner ?? '', dueDate: a.dueDate ?? '', status: a.status };
    this.editingTask.set(a);
  }

  protected async saveDecision(): Promise<void> {
    const d = this.editingDecision();
    const s = this.session();
    if (!d || !s || !this.decisionDraft.statement.trim()) return;
    await this.run(() =>
      this.api.editDecision(this.code(), s.sessionId, d.id, {
        statement: this.decisionDraft.statement.trim(),
        status: this.decisionDraft.status,
      }),
    );
    this.editingDecision.set(null);
  }

  protected async saveTask(): Promise<void> {
    const a = this.editingTask();
    const s = this.session();
    if (!a || !s || !this.taskDraft.task.trim()) return;
    await this.run(() =>
      this.api.editTask(this.code(), s.sessionId, a.id, {
        task: this.taskDraft.task.trim(),
        owner: this.taskDraft.owner.trim() || null,
        dueDate: this.taskDraft.dueDate || null,
        status: this.taskDraft.status,
      }),
    );
    this.editingTask.set(null);
  }

  protected async deleteItem(e: { kind: 'decisions' | 'tasks' | 'questions'; id: string }): Promise<void> {
    const s = this.session();
    if (!s) return;
    await this.run(() => this.api.deleteItem(this.code(), s.sessionId, e.kind, e.id), 'Removed');
  }

  protected openAdd(kind: 'task' | 'decision'): void {
    this.addTaskDraft = { task: '', owner: '', dueDate: '' };
    this.addDecisionDraft = { statement: '', status: 'agreed' };
    this.adding.set(kind);
  }

  protected async saveAdd(): Promise<void> {
    const s = this.session();
    const kind = this.adding();
    if (!s || !kind) return;
    if (kind === 'task') {
      if (!this.addTaskDraft.task.trim()) return;
      await this.run(() =>
        this.api.addTask(this.code(), s.sessionId, {
          task: this.addTaskDraft.task.trim(),
          owner: this.addTaskDraft.owner.trim() || null,
          dueDate: this.addTaskDraft.dueDate || null,
        }),
      );
    } else {
      if (!this.addDecisionDraft.statement.trim()) return;
      await this.run(() =>
        this.api.addDecision(this.code(), s.sessionId, { statement: this.addDecisionDraft.statement.trim(), status: this.addDecisionDraft.status }),
      );
    }
    this.adding.set(null);
  }

  protected openFix(l: TranscriptLine): void {
    if (!this.editable() || l.isAgent) return;
    this.speakerDraft = { to: '', all: false };
    this.fixing.set(l);
  }

  protected async saveFix(): Promise<void> {
    const l = this.fixing();
    const s = this.session();
    const to = this.speakerDraft.to.trim();
    if (!l || !s || !to || to === l.speakerName) return;
    await this.run(
      () => this.api.fixSpeaker(this.code(), s.sessionId, { from: l.speakerName, to, ...(this.speakerDraft.all ? {} : { seqs: [l.seq] }) }),
      'Speaker corrected. The AI learns from this.',
    );
    await this.select(s.sessionId);
    this.fixing.set(null);
  }

  private async run(fn: () => Promise<unknown>, done = 'Saved. The recap will refresh in a few minutes.'): Promise<void> {
    this.saving.set(true);
    try {
      await fn();
      await this.load(this.code(), true);
      this.toast.show(done);
    } catch (err) {
      this.toast.error(apiErrorMessage(err, 'Could not save that change.'));
    } finally {
      this.saving.set(false);
    }
  }
}
