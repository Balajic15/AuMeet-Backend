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

export interface Insights {
  summary: string;
  /** Only when the host prepared a goal / agenda (older notes may not have these). */
  goal?: GoalProgress | null;
  agenda?: AgendaProgress[];
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

export function isEmptyInsights(i: Insights | null | undefined): boolean {
  return !i || (!i.summary && !i.decisions?.length && !i.actionItems?.length && !i.openQuestions?.length);
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
