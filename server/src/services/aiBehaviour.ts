import mongoose from 'mongoose';
import { z } from 'zod';
import seed from '../config/ai-behaviour.seed.json' with { type: 'json' };
import { logger } from '../logger.js';

/*
 * The AI's behaviour is data: a system default in MongoDB (`ai_profiles`, _id "default"), the host's
 * account default (users.aiBehaviour) and a per-meeting override (meetings.aiBehaviour). The agent
 * layers them the same way (agent/src/behaviour.ts). The seed file only fills an empty database.
 */

const Limits = z.object({
  minGapSeconds: z.number().int().min(5).max(900),
  maxPerTenMinutes: z.number().int().min(0).max(30),
  pauseMs: z.number().int().min(400).max(8000),
  warmupSeconds: z.number().int().min(0).max(600),
  repeatTopicMinutes: z.number().int().min(1).max(240),
  minCheckSeconds: z.number().int().min(3).max(300),
});
const Engine = z.object({
  analysisBatchLines: z.number().int().min(1).max(50),
  analysisIdleSeconds: z.number().int().min(2).max(120),
  analysisMinIntervalSeconds: z.number().int().min(2).max(300),
  contextLines: z.number().int().min(5).max(200),
});
const WatchFor = z.object({
  decisions: z.boolean(),
  owners: z.boolean(),
  disputes: z.boolean(),
  goal: z.boolean(),
  time: z.boolean(),
  followUps: z.boolean(),
  contradictions: z.boolean(),
  risks: z.boolean(),
});

const Copilot = z.object({
  enabled: z.boolean(),
  /** 0–1: a suggestion needs at least this relevance to be shown. */
  minRelevance: z.number().min(0).max(1),
  maxSuggestions: z.number().int().min(1).max(8),
});

export const Behaviour = z.object({
  name: z.string().trim().min(1).max(30),
  wakeWords: z.array(z.string().trim().min(2).max(40)).max(30),
  talkativeness: z.number().min(0).max(1),
  tone: z.enum(['formal', 'neutral', 'casual']),
  replyLength: z.enum(['brief', 'normal', 'detailed']),
  watchFor: WatchFor,
  customInstructions: z.string().max(2000),
  learnFromReactions: z.boolean(),
  copilot: Copilot,
  limits: Limits,
  engine: Engine,
});
export type Behaviour = z.infer<typeof Behaviour>;

/** An override: any subset of the settings (engine tuning stays system-wide). */
export const BehaviourOverride = z
  .object({
    name: Behaviour.shape.name,
    wakeWords: Behaviour.shape.wakeWords,
    talkativeness: Behaviour.shape.talkativeness,
    tone: Behaviour.shape.tone,
    replyLength: Behaviour.shape.replyLength,
    watchFor: WatchFor.partial(),
    customInstructions: Behaviour.shape.customInstructions,
    learnFromReactions: Behaviour.shape.learnFromReactions,
    copilot: Copilot.partial(),
    limits: Limits.partial(),
  })
  .partial()
  .strict();
export type BehaviourOverride = z.infer<typeof BehaviourOverride>;

type Plain = Record<string, unknown>;
const isPlain = (v: unknown): v is Plain => !!v && typeof v === 'object' && !Array.isArray(v);

export function mergeLayers(...layers: unknown[]): Plain {
  const out: Plain = {};
  for (const layer of layers) {
    if (!isPlain(layer)) continue;
    for (const [k, v] of Object.entries(layer)) {
      if (v === undefined || v === null) continue;
      out[k] = isPlain(v) && isPlain(out[k]) ? mergeLayers(out[k], v) : v;
    }
  }
  return out;
}

const profiles = () => mongoose.connection.collection<{ _id: string } & Plain>('ai_profiles');

/**
 * Fill an empty database with the seed profile. An existing profile is never overwritten; settings added
 * in a newer version (missing from the stored profile) are filled in from the seed.
 */
export async function ensureDefaultProfile(): Promise<void> {
  const valid = Behaviour.parse(seed);
  const res = await profiles().updateOne({ _id: 'default' }, { $setOnInsert: valid }, { upsert: true });
  if (res.upsertedCount) {
    logger.info('AI behaviour: default profile created from the seed');
    return;
  }
  const doc = await profiles().findOne({ _id: 'default' });
  const { _id: _ignored, ...stored } = (doc ?? {}) as Plain;
  if (Behaviour.safeParse(stored).success) return;
  const filled = Behaviour.safeParse(mergeLayers(valid, stored));
  if (filled.success) {
    await profiles().replaceOne({ _id: 'default' }, filled.data);
    logger.info('AI behaviour: new settings added to the stored default profile');
  }
}

export async function defaultBehaviour(): Promise<Behaviour> {
  const doc = await profiles().findOne({ _id: 'default' });
  const { _id: _ignored, ...rest } = (doc ?? {}) as Plain;
  const parsed = Behaviour.safeParse(rest);
  if (parsed.success) return parsed.data;
  // Missing or damaged in the database: restore from the seed rather than run without a profile.
  await ensureDefaultProfile();
  return Behaviour.parse(seed);
}

export function resolve(base: Behaviour, ...overrides: unknown[]): Behaviour {
  const merged = Behaviour.safeParse(mergeLayers(base, ...overrides));
  return merged.success ? merged.data : base;
}
