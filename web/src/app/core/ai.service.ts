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
export type WatchKey = 'decisions' | 'owners' | 'disputes' | 'goal' | 'time' | 'followUps' | 'contradictions';
/** Any subset of the settings. */
export type BehaviourOverride = Partial<Omit<Behaviour, 'watchFor' | 'limits' | 'engine'>> & {
  watchFor?: Partial<Behaviour['watchFor']>;
  limits?: Partial<Behaviour['limits']>;
};

export interface LearningStat {
  intent: string;
  engaged: number;
  ignored: number;
  rejected: number;
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
