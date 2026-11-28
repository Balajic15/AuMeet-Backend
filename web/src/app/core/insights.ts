import { HttpClient } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import type { Meeting } from './meetings.service';

/* Mirrors agent/src/intel/schema.ts (Insights). */

export type DecisionStatus = 'proposed' | 'agreed' | 'disputed' | 'rejected';

export interface Decision {
  id: string;
  topic: string;
  statement: string;
  status: DecisionStatus;
  options: string[];
  proposedBy: string[];
  supporters: string[];
  objectors: string[];
  confirmationNeeded: string | null;
  /** An earlier meeting's agreed decision that this one goes against. */
  contradicts?: { ref: string; statement: string; date: string; title: string } | null;
  evidence: number[];
}

export interface ActionItem {
  id: string;
  task: string;
  owner: string | null;
  ownerUserId: string | null;
  deadline: string | null;
  dueDate: string | null;
  status: 'open' | 'done';
  evidence: number[];
}

export interface OpenQuestion {
  id: string;
  question: string;
  askedBy: string | null;
  status: 'open' | 'answered';
  evidence: number[];
}

export interface Topic {
  id: string;
  title: string;
  status: 'active' | 'closed';
}

export type AgendaStatus = 'not_started' | 'in_progress' | 'done' | 'skipped';
export type GoalStatus = 'no_goal' | 'on_track' | 'drifting' | 'off_track' | 'achieved';

export interface AgendaProgress {
  id: string;
  title: string;
  minutes: number | null;
  status: AgendaStatus;
  note: string;
  startedAt: string | null;
  doneAt: string | null;
}

export interface GoalProgress {
  text: string;
  status: GoalStatus;
  reason: string;
  since: string;
}

export interface KeyPoint {
  id: string;
  point: string;
  importance: 'high' | 'normal';
  evidence: number[];
}

export interface Assumption {
  id: string;
  statement: string;
  madeBy: string | null;
  status: 'unverified' | 'confirmed' | 'invalidated';
  evidence: number[];
}

export type RiskKind = 'conflict' | 'dependency' | 'deadline' | 'blocker' | 'contradiction' | 'other';

export interface Risk {
  id: string;
  kind: RiskKind;
  description: string;
  involves: string[];
  relatedItems: string[];
  earlier: { ref: string; kind: 'task' | 'risk'; text: string; date: string; title: string } | null;
  severity: 'low' | 'medium' | 'high';
  suggestedQuestion: string | null;
  status: 'open' | 'resolved';
  evidence: number[];
}

/** Live guidance from the copilot (replaced on every analysis). */
export interface Copilot {
  currentFocus: string;
  offTopic: boolean;
  offTopicNote: string;
  missingInfo: string[];
  suggestedQuestions: string[];
  discussNext: string;
  agendaAdvice: string;
  updatedAt: string;
}

export interface Insights {
  summary: string;
  keyPoints?: KeyPoint[];
  assumptions?: Assumption[];
  risks?: Risk[];
  copilot?: Copilot | null;
  /** Only when the host prepared a goal / agenda (older notes may not have these). */
  goal?: GoalProgress | null;
  agenda?: AgendaProgress[];
  /** Left open at the previous meeting. */
  carryover?: {
    fromTitle: string;
    fromDate: string;
    decisions: Array<{ statement: string; options: string[] }>;
    tasks: Array<{ task: string; owner: string | null; dueDate: string | null; overdue: boolean }>;
  } | null;
  topics: Topic[];
  decisions: Decision[];
  actionItems: ActionItem[];
  openQuestions: OpenQuestion[];
  analyzedThrough: number;
  updatedAt: string;
}

export interface Recap {
  headline: string;
  overview: string;
  highlights: string[];
  nextSteps: string[];
  goalOutcome?: { status: 'met' | 'partly_met' | 'not_met'; summary: string } | null;
  /** What the meeting set out to do but didn't finish. */
  unfinished?: string[];
  generatedAt: string;
}

export interface InsightSession {
  sessionId: string;
  startedAt: string | null;
  updatedAt: string | null;
  endedAt: string | null;
  participants: string[];
  insights: Insights | null;
  /** Written by the server worker after the session ends. */
  recap: Recap | null;
}

export interface TranscriptLine {
  seq: number;
  speakerName: string;
  isAgent: boolean;
  channel: 'voice' | 'chat';
  text: string;
  at: string;
}

export type FollowActionKind = 'email' | 'reminder' | 'calendar' | 'task_sync';

export interface FollowAction {
  id: string;
  sessionId: string;
  meetingCode: string;
  meetingTitle?: string;
  kind: FollowActionKind;
  status: 'proposed' | 'approved' | 'done' | 'dismissed' | 'failed';
  needsApproval: boolean;
  taskId: string | null;
  recipients: Array<{ name: string; userId: string | null }>;
  title: string;
  body: string;
  when: string | null;
  durationMinutes: number | null;
  reason: string;
  result: string | null;
  error: string | null;
  /** gmail, smtp, google_calendar, ics, jira, linear, asana, webhook */
  channel: string | null;
  attempts: number;
  nextAttemptAt: string | null;
  external: { provider: string; key: string; url: string } | null;
  executedAt: string | null;
  createdAt: string | null;
}

export interface ActionsResponse {
  actions: FollowAction[];
  planned: boolean;
  canPlan: boolean;
  mail: boolean;
}

export interface SpeakerStat {
  name: string;
  lines: number;
  words: number;
  seconds: number;
  share: number;
}

export interface SessionMetrics {
  sessionId: string;
  meetingCode: string;
  title: string;
  startedAt: string | null;
  durationMinutes: number;
  participants: number;
  speakers: SpeakerStat[];
  balance: number | null;
  agenda: { total: number; done: number; skipped: number; completion: number | null };
  goal: string | null;
  decisions: { total: number; agreed: number; open: number; avgMinutesToDecide: number | null };
  tasks: { total: number; done: number; open: number; overdue: number; unowned: number; completion: number | null };
  unresolved: number;
  risks: number;
}

export function isEmptyInsights(i: Insights | null | undefined): boolean {
  return (
    !i ||
    (!i.summary && !i.decisions?.length && !i.actionItems?.length && !i.openQuestions?.length && !i.risks?.length && !i.copilot?.currentFocus)
  );
}

@Injectable({ providedIn: 'root' })
export class InsightsService {
  private readonly http = inject(HttpClient);

  get(code: string): Promise<{ meeting: Meeting; sessions: InsightSession[] }> {
    return firstValueFrom(this.http.get<{ meeting: Meeting; sessions: InsightSession[] }>(`/api/meetings/${code}/insights`));
  }

  editDecision(code: string, sessionId: string, id: string, body: { statement?: string; status?: DecisionStatus }): Promise<unknown> {
    return firstValueFrom(this.http.patch(`/api/meetings/${code}/insights/${encodeURIComponent(sessionId)}/decisions/${encodeURIComponent(id)}`, body));
  }

  editTask(
    code: string,
    sessionId: string,
    id: string,
    body: { task?: string; owner?: string | null; dueDate?: string | null; status?: 'open' | 'done' },
  ): Promise<unknown> {
    return firstValueFrom(this.http.patch(`/api/meetings/${code}/insights/${encodeURIComponent(sessionId)}/tasks/${encodeURIComponent(id)}`, body));
  }

  deleteItem(code: string, sessionId: string, kind: 'decisions' | 'tasks' | 'questions', id: string): Promise<unknown> {
    return firstValueFrom(this.http.delete(`/api/meetings/${code}/insights/${encodeURIComponent(sessionId)}/${kind}/${encodeURIComponent(id)}`));
  }

  addTask(code: string, sessionId: string, body: { task: string; owner?: string | null; dueDate?: string | null }): Promise<unknown> {
    return firstValueFrom(this.http.post(`${this.base(code, sessionId)}/tasks`, body));
  }

  addDecision(code: string, sessionId: string, body: { statement: string; status: DecisionStatus }): Promise<unknown> {
    return firstValueFrom(this.http.post(`${this.base(code, sessionId)}/decisions`, body));
  }

  /** Correct a misidentified speaker (all their lines, or only `seqs`). */
  fixSpeaker(code: string, sessionId: string, body: { from: string; to: string; seqs?: number[] }): Promise<{ lines: number }> {
    return firstValueFrom(this.http.patch<{ lines: number }>(`${this.base(code, sessionId)}/speakers`, body));
  }

  actions(code: string, sessionId: string): Promise<ActionsResponse> {
    return firstValueFrom(this.http.get<ActionsResponse>(`${this.base(code, sessionId)}/actions`));
  }

  planActions(code: string, sessionId: string): Promise<{ actions: FollowAction[] }> {
    return firstValueFrom(this.http.post<{ actions: FollowAction[] }>(`${this.base(code, sessionId)}/actions/plan`, {}));
  }

  decideAction(
    code: string,
    sessionId: string,
    id: string,
    body: { status?: 'approved' | 'dismissed'; title?: string; body?: string; when?: string },
  ): Promise<{ action: FollowAction }> {
    return firstValueFrom(this.http.patch<{ action: FollowAction }>(`${this.base(code, sessionId)}/actions/${encodeURIComponent(id)}`, body));
  }

  retryAction(code: string, sessionId: string, id: string): Promise<{ action: FollowAction }> {
    return firstValueFrom(this.http.post<{ action: FollowAction }>(`${this.base(code, sessionId)}/actions/${encodeURIComponent(id)}/retry`, {}));
  }

  sessionMetrics(sessionId: string): Promise<{ metrics: SessionMetrics }> {
    return firstValueFrom(this.http.get<{ metrics: SessionMetrics }>(`/api/analytics/sessions/${encodeURIComponent(sessionId)}`));
  }

  private base(code: string, sessionId: string): string {
    return `/api/meetings/${code}/insights/${encodeURIComponent(sessionId)}`;
  }

  /** Same-origin link; the session cookie authorises the download. */
  transcriptDownloadUrl(code: string, sessionId: string): string {
    return `/api/meetings/${code}/insights/${encodeURIComponent(sessionId)}/transcript?format=txt`;
  }

  async transcript(code: string, sessionId: string): Promise<TranscriptLine[]> {
    const res = await firstValueFrom(
      this.http.get<{ lines: TranscriptLine[] }>(`/api/meetings/${code}/insights/${encodeURIComponent(sessionId)}/transcript`),
    );
    return res.lines;
  }
}
