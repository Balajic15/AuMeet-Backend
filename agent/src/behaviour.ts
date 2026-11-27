import type { Db } from 'mongodb';
import { z } from 'zod';

/*
 * How the AI behaves – all data, no behaviour constants in code:
 *   system default (MongoDB `ai_profiles`, _id "default", seeded by the server)
 *   ← the host's account default (users.aiBehaviour)
 *   ← this meeting's override (meetings.aiBehaviour)
 * The server validates edits with the same shape (server/src/services/aiBehaviour.ts).
 */

export const Behaviour = z.object({
  /** What people call the AI. */
  name: z.string().trim().min(1).max(30),
  /** Other spellings speech-to-text produces for the name (any script). */
  wakeWords: z.array(z.string().trim().min(2).max(40)).max(30),
  /** 0 = only when asked … 1 = speaks up whenever it helps. */
  talkativeness: z.number().min(0).max(1),
  tone: z.enum(['formal', 'neutral', 'casual']),
  replyLength: z.enum(['brief', 'normal', 'detailed']),
  /** What it may raise on its own. */
  watchFor: z.object({
    decisions: z.boolean(),
    owners: z.boolean(),
    disputes: z.boolean(),
    goal: z.boolean(),
    time: z.boolean(),
    followUps: z.boolean(),
    contradictions: z.boolean(),
  }),
  /** Free text from the host, e.g. "Mostly speak Hindi", "Be very brief", "Never joke". */
  customInstructions: z.string().max(2000),
  /** Use how this team reacted to earlier remarks. */
  learnFromReactions: z.boolean(),
  limits: z.object({
    /** Shortest gap between two remarks it makes on its own. */
    minGapSeconds: z.number().int().min(5).max(900),
    maxPerTenMinutes: z.number().int().min(0).max(30),
    /** Silence that counts as a pause. */
    pauseMs: z.number().int().min(400).max(8000),
    /** Quiet period after joining (the greeting is exempt). */
    warmupSeconds: z.number().int().min(0).max(600),
    /** The same issue is not raised again within this time. */
    repeatTopicMinutes: z.number().int().min(1).max(240),
    /** How often the meeting may be re-assessed at most. */
    minCheckSeconds: z.number().int().min(3).max(300),
  }),
  /** Engine tuning (note-taker cadence, context sizes). */
  engine: z.object({
    analysisBatchLines: z.number().int().min(1).max(50),
    analysisIdleSeconds: z.number().int().min(2).max(120),
    analysisMinIntervalSeconds: z.number().int().min(2).max(300),
    contextLines: z.number().int().min(5).max(200),
  }),
});
export type Behaviour = z.infer<typeof Behaviour>;

type Plain = Record<string, unknown>;
const isPlain = (v: unknown): v is Plain => !!v && typeof v === 'object' && !Array.isArray(v);

/** Objects merge key by key; arrays and values replace. */
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

export function resolveBehaviour(...layers: unknown[]): Behaviour | null {
  const parsed = Behaviour.safeParse(mergeLayers(...layers));
  return parsed.success ? parsed.data : null;
}

/** Loads the effective behaviour for a meeting; null when no profile is available. */
export async function loadBehaviour(db: Db, meetingCode: string): Promise<{ behaviour: Behaviour | null; hostId: string | null }> {
  const meeting = await db.collection('meetings').findOne({ code: meetingCode }, { projection: { host: 1, aiBehaviour: 1 } });
  const hostId = meeting?.['host'] ? String(meeting['host']) : null;
  const [profile, host] = await Promise.all([
    db.collection<{ _id: string }>('ai_profiles').findOne({ _id: 'default' }),
    meeting?.['host'] ? db.collection('users').findOne({ _id: meeting['host'] }, { projection: { aiBehaviour: 1 } }) : null,
  ]);
  const { _id: _ignored, ...defaults } = (profile ?? {}) as Plain;
  return { behaviour: resolveBehaviour(defaults, host?.['aiBehaviour'], meeting?.['aiBehaviour']), hostId };
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const isLatin = (s: string) => /^[\p{Script=Latin}\d\s'-]+$/u.test(s);

/** Fast path so replies to "<name>, …" stay instant; the wake words are data, not code. */
export function wakeMatcher(b: Pick<Behaviour, 'name' | 'wakeWords'>): (text: string) => boolean {
  const words = [b.name, ...b.wakeWords].map((w) => w.trim()).filter(Boolean);
  const latin = words.filter(isLatin);
  const other = words.filter((w) => !isLatin(w)).map((w) => w.toLowerCase());
  // Latin names: whole words, spaces/hyphens optional ("Au Meet", "au-meet").
  const re = latin.length
    ? new RegExp(`\\b(?:${latin.map((w) => escapeRe(w).replace(/\s+|-/g, '[\\s-]?')).join('|')})\\b`, 'i')
    : null;
  return (text) => (re?.test(text) ?? false) || other.some((w) => text.toLowerCase().includes(w));
}

/** What a talkativeness level means in practice – the model follows words far better than a bare number. */
export function talkativenessMeaning(t: number): string {
  if (t <= 0) return 'never speak up on your own; only answer when asked.';
  if (t < 0.3) return 'speak up only when something serious would otherwise go wrong (e.g. a key decision is about to be left unconfirmed at the end); stay silent about minor points like small tasks or tangents.';
  if (t < 0.6) return 'speak up when it clearly helps the meeting reach its goal; let minor things go.';
  if (t < 0.85) return 'speak up readily whenever something useful is being missed.';
  return 'be an active participant: raise anything useful, including smaller points.';
}

/** Plain-language description of the settings, for the model's instructions. */
export function describeBehaviour(b: Behaviour): string {
  const watching = Object.entries(b.watchFor)
    .filter(([, on]) => on)
    .map(([k]) => k);
  return [
    `Your name is ${b.name}.`,
    `Talkativeness ${b.talkativeness.toFixed(2)} on a 0–1 scale: ${talkativenessMeaning(b.talkativeness)}`,
    `Tone: ${b.tone}. Reply length: ${b.replyLength}.`,
    watching.length ? `You may raise on your own: ${watching.join(', ')}.` : 'Do not raise anything on your own.',
    b.customInstructions.trim() ? `Host's instructions: ${b.customInstructions.trim()}` : '',
  ]
    .filter(Boolean)
    .join('\n');
}
