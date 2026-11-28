import { HttpClient } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { firstValueFrom } from 'rxjs';

/** How the AI behaves (server: services/aiBehaviour.ts). */
export interface Behaviour {
  name: string;
  wakeWords: string[];
  talkativeness: number;
  tone: 'formal' | 'neutral' | 'casual';
  replyLength: 'brief' | 'normal' | 'detailed';
  watchFor: Record<WatchKey, boolean>;
  customInstructions: string;
  learnFromReactions: boolean;
  /** The on-screen copilot in meetings. */
  copilot: { enabled: boolean; minRelevance: number; maxSuggestions: number };
  limits: {
    minGapSeconds: number;
    maxPerTenMinutes: number;
    pauseMs: number;
    warmupSeconds: number;
    repeatTopicMinutes: number;
    minCheckSeconds: number;
  };
  engine?: Record<string, number>;
}
export type WatchKey = 'decisions' | 'owners' | 'disputes' | 'goal' | 'time' | 'followUps' | 'contradictions' | 'risks';
/** Any subset of the settings. */
export type BehaviourOverride = Partial<Omit<Behaviour, 'watchFor' | 'limits' | 'engine' | 'copilot'>> & {
  watchFor?: Partial<Behaviour['watchFor']>;
  copilot?: Partial<Behaviour['copilot']>;
  limits?: Partial<Behaviour['limits']>;
};

export interface LearningStat {
  intent: string;
  engaged: number;
  ignored: number;
  rejected: number;
}

export interface FollowThroughSettings {
  enabled: boolean;
  autoApproveReminders: boolean;
  overdueNotices: boolean;
  webhookUrl: string | null;
  autoSyncTasks: boolean;
}

export interface LearningPolicy {
  minCorrections: number;
  minSessions: number;
  minPeople: number;
  minConfidence: number;
  windowDays: number;
  maxLessons: number;
  maxVersions: number;
}

export interface CorrectionBrief {
  id: string;
  kind: string;
  action: 'edit' | 'delete' | 'add';
  field: string | null;
  before: unknown;
  after: unknown;
  at: string;
  sessionId: string;
  excluded: boolean;
}

export interface Lesson {
  id: string;
  text: string;
  topic: string;
  /** active = applied in meetings; candidate = waiting for more evidence; off = switched off. */
  status: 'active' | 'candidate' | 'off';
  reason: string;
  confidence: number;
  support: { corrections: number; sessions: number; people: number };
  evidence: string[];
  evidenceDetail: CorrectionBrief[];
  contradictedDetail: CorrectionBrief[];
  since: number;
}

export interface LessonVersionInfo {
  version: number;
  createdAt: string;
  source: 'learn' | 'rollback' | 'toggle' | 'exclude' | 'policy';
  fromVersion: number | null;
  note: string;
  active: number;
  candidates: number;
  lessons: Array<{ id: string; text: string; status: Lesson['status'] }>;
}

export interface Feedback {
  total: number;
  excluded: number;
  quarantined: number;
  mistakes: Array<{ kind: string; action: string; field: string | null; count: number; lastAt: string }>;
  lessons: Lesson[];
  versions: LessonVersionInfo[];
  current: number | null;
  policy: { system: LearningPolicy; host: Partial<LearningPolicy>; effective: LearningPolicy };
  disabled: string[];
  learnedAt: string | null;
  canLearn: boolean;
}

type Plain = Record<string, unknown>;
const isPlain = (v: unknown): v is Plain => !!v && typeof v === 'object' && !Array.isArray(v);

/** Only what differs from the layer below – so later changes to that layer still flow through. */
export function behaviourDiff(value: Behaviour, base: Behaviour): BehaviourOverride {
  const diff = (a: unknown, b: unknown): unknown => {
    if (isPlain(a) && isPlain(b)) {
      const out: Plain = {};
      for (const k of Object.keys(a)) {
        if (k === 'engine') continue;
        const d = diff(a[k], b[k]);
        if (d !== undefined) out[k] = d;
      }
      return Object.keys(out).length ? out : undefined;
    }
    return JSON.stringify(a) === JSON.stringify(b) ? undefined : a;
  };
  return (diff(value, base) ?? {}) as BehaviourOverride;
}

@Injectable({ providedIn: 'root' })
export class AiService {
  private readonly http = inject(HttpClient);

  account(): Promise<{ defaults: Behaviour; account: BehaviourOverride; effective: Behaviour }> {
    return firstValueFrom(this.http.get<{ defaults: Behaviour; account: BehaviourOverride; effective: Behaviour }>('/api/ai/behaviour'));
  }

  saveAccount(account: BehaviourOverride | null) {
    return firstValueFrom(this.http.put<{ defaults: Behaviour; account: BehaviourOverride; effective: Behaviour }>('/api/ai/behaviour', { account }));
  }

  learning(): Promise<{ stats: LearningStat[]; total: number }> {
    return firstValueFrom(this.http.get<{ stats: LearningStat[]; total: number }>('/api/ai/learning'));
  }

  async resetLearning(): Promise<number> {
    return (await firstValueFrom(this.http.delete<{ deleted: number }>('/api/ai/learning'))).deleted;
  }

  followThrough(): Promise<{ settings: FollowThroughSettings; mail: boolean }> {
    return firstValueFrom(this.http.get<{ settings: FollowThroughSettings; mail: boolean }>('/api/ai/follow-through'));
  }

  saveFollowThrough(patch: Partial<FollowThroughSettings>): Promise<{ settings: FollowThroughSettings; mail: boolean }> {
    return firstValueFrom(this.http.put<{ settings: FollowThroughSettings; mail: boolean }>('/api/ai/follow-through', patch));
  }

  feedback(): Promise<Feedback> {
    return firstValueFrom(this.http.get<Feedback>('/api/ai/feedback'));
  }

  relearn(): Promise<Feedback> {
    return firstValueFrom(this.http.post<Feedback>('/api/ai/feedback/learn', {}));
  }

  toggleLesson(id: string, active: boolean): Promise<Feedback> {
    return firstValueFrom(this.http.patch<Feedback>(`/api/ai/feedback/lessons/${encodeURIComponent(id)}`, { active }));
  }

  rollbackLessons(version: number): Promise<Feedback> {
    return firstValueFrom(this.http.post<Feedback>('/api/ai/feedback/rollback', { version }));
  }

  /** "This correction was wrong" (excluded) or restore it. */
  excludeCorrection(id: string, excluded: boolean): Promise<Feedback> {
    return firstValueFrom(this.http.patch<Feedback>(`/api/ai/feedback/corrections/${encodeURIComponent(id)}`, { excluded }));
  }

  saveLearningPolicy(patch: Partial<LearningPolicy>): Promise<Feedback> {
    return firstValueFrom(this.http.put<Feedback>('/api/ai/feedback/policy', patch));
  }

  async resetFeedback(): Promise<number> {
    return (await firstValueFrom(this.http.delete<{ deleted: number }>('/api/ai/feedback'))).deleted;
  }

  readonly feedbackDatasetUrl = '/api/ai/feedback/dataset';

  meeting(code: string): Promise<{ account: Behaviour; meeting: BehaviourOverride | null; effective: Behaviour }> {
    return firstValueFrom(this.http.get<{ account: Behaviour; meeting: BehaviourOverride | null; effective: Behaviour }>(`/api/meetings/${code}/ai-behaviour`));
  }

  /** replace = set this meeting's overrides exactly (null = use my default); merge = change just these. */
  async saveMeeting(code: string, aiBehaviour: BehaviourOverride | null, mode: 'merge' | 'replace'): Promise<void> {
    await firstValueFrom(this.http.patch(`/api/meetings/${code}`, { aiBehaviour, aiBehaviourMode: mode }));
  }
}

export function talkLabel(v: number): string {
  if (v <= 0) return 'Only when asked';
  if (v < 0.35) return 'Rarely';
  if (v < 0.65) return 'When it helps';
  if (v < 0.9) return 'Often';
  return 'Very active';
}
