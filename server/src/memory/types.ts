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
}

export interface StoredActionItem {
  id: string;
  task: string;
  owner: string | null;
  ownerUserId: string | null;
  deadline: string | null;
  dueDate: string | null;
  status: 'open' | 'done';
}

export interface StoredInsights {
  summary?: string;
  decisions?: StoredDecision[];
  actionItems?: StoredActionItem[];
  openQuestions?: Array<{ id: string; question: string; status: 'open' | 'answered' }>;
  topics?: Array<{ id: string; title: string }>;
}

export interface Recap {
  headline: string;
  overview: string;
  highlights: string[];
  nextSteps: string[];
  goalOutcome?: { status: 'met' | 'partly_met' | 'not_met' | 'no_goal'; summary: string } | null;
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
