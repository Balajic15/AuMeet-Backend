import { ChangeDetectionStrategy, Component, effect, inject, input, signal, untracked } from '@angular/core';
import { DatePipe } from '@angular/common';
import { HttpClient } from '@angular/common/http';
import { firstValueFrom } from 'rxjs';

interface AuditEvent {
  at: string;
  action: string;
  actorName: string;
  ip: string | null;
  sessionId?: string;
  target?: string;
  meta?: { fields?: string[]; values?: Record<string, unknown> };
}

const LABELS: Record<string, string> = {
  'meeting.created': 'created the meeting',
  'meeting.updated': 'changed meeting settings',
  'meeting.joined': 'joined',
  'meeting.ended': 'ended the meeting',
  'meeting.invited': 'sent invitations',
  'meeting.join_request_decided': 'answered a request to join',
  'participant.muted': 'muted a participant',
  'participant.removed': 'removed a participant',
  'recording.started': 'started recording',
  'recording.stopped': 'stopped recording',
  'recording.downloaded': 'downloaded a recording',
  'document.uploaded': 'uploaded a document',
  'document.deleted': 'deleted a document',
  'notes.viewed': 'opened the notes',
  'transcript.viewed': 'viewed the transcript',
  'transcript.downloaded': 'downloaded the transcript',
  'transcript.speaker_corrected': 'corrected a speaker',
  'notes.decision_edited': 'edited a decision',
  'notes.task_edited': 'edited a task',
  'notes.item_deleted': 'deleted an item from the notes',
  'notes.task_added': 'added a task',
  'notes.decision_added': 'added a decision',
  'followthrough.planned': 'planned follow-ups',
  'followthrough.action_decided': 'decided on a follow-up',
};

/** Host only: who joined, read transcripts or recordings, edited notes or controlled the room. */
@Component({
  selector: 'app-meeting-activity',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [DatePipe],
  template: `
    <p class="muted">Only you, the host, can see this. Events are kept for a year.</p>
    @if (events() === null) {
      <p class="muted">Loading…</p>
    } @else if (!events()!.length) {
      <p class="muted">No activity recorded yet.</p>
    } @else {
      <ul class="log">
        @for (e of events(); track $index) {
          <li>
            <span class="when">{{ e.at | date: 'd MMM, HH:mm' }}</span>
            <span><strong>{{ e.actorName }}</strong> {{ label(e) }}@if (detail(e); as d) { <span class="muted"> · {{ d }}</span> }</span>
          </li>
        }
      </ul>
    }
  `,
  styles: `
    :host { display: block; }
    .muted { color: var(--text-muted); font-size: 13.5px; margin: 0 0 12px; }
    .log { list-style: none; margin: 0; padding: 0; }
    .log li { display: grid; grid-template-columns: 110px 1fr; gap: 12px; padding: 7px 0; border-bottom: 1px solid #222; font-size: 14px; line-height: 1.45; }
    .when { color: var(--text-muted); font-size: 12.5px; font-variant-numeric: tabular-nums; }
    @media (max-width: 520px) { .log li { grid-template-columns: 1fr; gap: 2px; } }
  `,
})
export class MeetingActivity {
  readonly code = input.required<string>();
  private readonly http = inject(HttpClient);
  protected readonly events = signal<AuditEvent[] | null>(null);

  constructor() {
    effect(() => {
      const code = this.code();
      untracked(() => {
        this.events.set(null);
        firstValueFrom(this.http.get<{ events: AuditEvent[] }>(`/api/meetings/${code}/audit`)).then(
          (r) => this.events.set(r.events),
          () => this.events.set([]),
        );
      });
    });
  }

  protected label(e: AuditEvent): string {
    return LABELS[e.action] ?? e.action.replace(/[._]/g, ' ');
  }

  protected detail(e: AuditEvent): string {
    const v = e.meta?.values ? Object.entries(e.meta.values).map(([k, x]) => `${k}: ${String(x)}`) : [];
    const f = e.meta?.fields?.filter((x) => !(e.meta?.values && x in e.meta.values)) ?? [];
    return [...v, ...(f.length ? [`changed ${f.join(', ')}`] : [])].join(' · ');
  }
}
