/* Shapes written by the agent (agent/src/intel/schema.ts). Only the fields the server reads. */

export interface StoredDecision {
  id: string;
  topic?: string;
  statement: string;
  status: 'proposed' | 'agreed' | 'disputed' | 'rejected';
  options?: string[];
  proposedBy?: string[];
  supporters?: string[];
  objectors?: string[];
  confirmationNeeded?: string | null;
  firstSeenAt?: string;
  settledAt?: string | null;
  evidence?: number[];
}

export interface StoredActionItem {
  id: string;
  task: string;
  owner: string | null;
  ownerUserId: string | null;
  deadline: string | null;
  dueDate: string | null;
  status: 'open' | 'done';
  /** Issue created in Jira / Linear / Asana for this task. */
  external?: { provider: 'jira' | 'linear' | 'asana'; id: string; key: string; url: string } | null;
  evidence?: number[];
  firstSeenAt?: string;
  updatedAt?: string;
}

export interface StoredRisk {
  id: string;
  kind: string;
  description: string;
  involves?: string[];
  severity?: 'low' | 'medium' | 'high';
  suggestedQuestion?: string | null;
  status: 'open' | 'resolved';
}

export interface StoredInsights {
  summary?: string;
  decisions?: StoredDecision[];
  actionItems?: StoredActionItem[];
  openQuestions?: Array<{ id: string; question: string; status: 'open' | 'answered' }>;
  topics?: Array<{ id: string; title: string }>;
  risks?: StoredRisk[];
  assumptions?: Array<{ id: string; statement: string; status: string }>;
  keyPoints?: Array<{ id: string; point: string; importance: string }>;
  agenda?: Array<{ id: string; title: string; minutes: number | null; status: string; startedAt?: string | null; doneAt?: string | null }>;
  goal?: { text: string; status: string } | null;
}

export interface Recap {
  headline: string;
  overview: string;
  highlights: string[];
  nextSteps: string[];
  goalOutcome?: { status: 'met' | 'partly_met' | 'not_met' | 'no_goal'; summary: string } | null;
  /** Objectives, agenda items and issues the meeting did not finish. */
  unfinished?: string[];
  generatedAt: string;
}

export interface SessionDoc {
  sessionId: string;
  meetingCode: string;
  title?: string;
  startedAt?: Date;
  endedAt?: Date;
  updatedAt?: Date;
  insights?: StoredInsights | null;
  participants?: Array<{ name?: string; userId?: string | null }>;
  participantUserIds?: string[];
  recap?: Recap;
}

export interface TranscriptRow {
  seq: number;
  speakerName: string;
  isAgent?: boolean;
  channel?: string;
  text: string;
  at?: Date;
}
