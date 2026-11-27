import { HttpClient } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { firstValueFrom } from 'rxjs';

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
}
