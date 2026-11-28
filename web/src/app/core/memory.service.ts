import { HttpClient } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import type { FollowAction, SessionMetrics } from './insights';

export interface AnalyticsSummary {
  meetings: number;
  hours: number;
  avgMinutes: number | null;
  avgParticipants: number | null;
  avgBalance: number | null;
  agendaCompletion: number | null;
  decisionsPerMeeting: number | null;
  avgMinutesToDecide: number | null;
  unresolvedPerMeeting: number | null;
  taskCompletion: number | null;
  tasks: number;
  overdueTasks: number;
  goalMetRate: number | null;
  meetingsWithoutOutcome: number;
}

export interface AnalyticsOverview {
  days: number;
  summary: AnalyticsSummary;
  previous: AnalyticsSummary;
  weeks: Array<{ week: string; meetings: number; hours: number; decisions: number; tasks: number; tasksDone: number }>;
  people: Array<{ name: string; meetings: number; minutes: number; avgShare: number }>;
  recurringTopics: Array<{ title: string; meetings: number }>;
  sessions: SessionMetrics[];
  aiEnabled: boolean;
}

export interface AnalyticsInsight {
  kind: 'win' | 'issue' | 'suggestion';
  title: string;
  detail: string;
}

@Injectable({ providedIn: 'root' })
export class AnalyticsService {
  private readonly http = inject(HttpClient);

  overview(days: number): Promise<AnalyticsOverview> {
    return firstValueFrom(this.http.get<AnalyticsOverview>(`/api/analytics?days=${days}`));
  }

  insights(days: number): Promise<{ insights: AnalyticsInsight[] }> {
    return firstValueFrom(this.http.post<{ insights: AnalyticsInsight[] }>('/api/analytics/insights', { days }));
  }
}

export interface MyTask {
  sessionId: string;
  meetingCode: string;
  meetingTitle: string;
  meetingDate: string | null;
  /** False while the meeting is still running (the live note-taker owns it). */
  editable: boolean;
  id: string;
  task: string;
  deadline: string | null;
  dueDate: string | null;
  status: 'open' | 'done';
}

export interface OpenDecision {
  sessionId: string;
  meetingCode: string;
  meetingTitle: string;
  meetingDate: string | null;
  id: string;
  statement: string;
  status: 'disputed' | 'proposed';
  options: string[];
  confirmationNeeded: string | null;
}

export interface Overview {
  tasks: MyTask[];
  openDecisions: OpenDecision[];
  askEnabled: boolean;
}

export interface AskSource {
  meetingCode: string;
  sessionId: string;
  meetingTitle: string;
  meetingDate: string | null;
  kind: 'recap' | 'decision' | 'task' | 'transcript';
  excerpt: string;
}

export interface AskResult {
  answer: string;
  sources: AskSource[];
}

@Injectable({ providedIn: 'root' })
export class MemoryService {
  private readonly http = inject(HttpClient);

  overview(): Promise<Overview> {
    return firstValueFrom(this.http.get<Overview>('/api/memory/overview'));
  }

  setTaskStatus(sessionId: string, taskId: string, status: 'open' | 'done'): Promise<unknown> {
    return firstValueFrom(
      this.http.patch(`/api/memory/tasks/${encodeURIComponent(sessionId)}/${encodeURIComponent(taskId)}`, { status }),
    );
  }

  ask(question: string): Promise<AskResult> {
    return firstValueFrom(this.http.post<AskResult>('/api/memory/ask', { question }));
  }

  /** Who owns what across all my meetings. */
  commitments(): Promise<Commitments> {
    return firstValueFrom(this.http.get<Commitments>('/api/memory/commitments'));
  }

  /** Follow-up actions waiting for my approval. */
  pendingActions(): Promise<{ actions: FollowAction[] }> {
    return firstValueFrom(this.http.get<{ actions: FollowAction[] }>('/api/memory/follow-through'));
  }
}

export interface CommitmentTask {
  sessionId: string;
  meetingCode: string;
  meetingTitle: string;
  meetingDate: string | null;
  id: string;
  task: string;
  owner: string | null;
  dueDate: string | null;
  status: 'open' | 'done';
  overdue: boolean;
}

export interface Commitments {
  owners: Array<{ owner: string | null; open: number; overdue: number; tasks: CommitmentTask[] }>;
  totals: { open: number; overdue: number; done: number; unowned: number };
  risks: Array<{ sessionId: string; meetingCode: string; meetingTitle: string; meetingDate: string | null; id: string; kind: string; description: string; severity: string }>;
}
