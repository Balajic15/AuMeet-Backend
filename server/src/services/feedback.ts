import mongoose, { Types } from 'mongoose';
import { z } from 'zod';
import type { AiClient } from '../ai/gemini.js';
import policySeed from '../config/learning-policy.seed.json' with { type: 'json' };
import { logger } from '../logger.js';
import { TranscriptLineModel } from '../models/Insights.js';

/*
 * Self-improving notes, safely.
 *
 * Every correction people make to the AI's notes is stored with the transcript lines it was based on
 * (`ai_corrections`, the evaluation dataset). The worker turns recurring corrections into lessons the live
 * note-taker follows (`ai_lessons`). One wrong correction must never become a team rule, so:
 *
 *  - Evidence is counted here, not by the model: a lesson cites the corrections it generalises, and only
 *    corrections that exist, are inside the policy window, weren't undone later, weren't marked wrong and
 *    aren't quarantined count. Support = distinct corrections, meetings and people.
 *  - Confidence thresholds (the learning policy, stored data): a lesson is applied ("active") only with enough
 *    corrections, from enough meetings and people, model confidence above the bar, and no correction against
 *    it. Otherwise it waits as a "candidate" and is never sent to the note-taker.
 *  - Nothing is permanent: lessons are re-derived from recent corrections only, so unsupported ones expire.
 *  - Versioning: every change (learning run, rollback, switching a lesson off, excluding a correction) is a
 *    new numbered version; the agent applies only the current one.
 *  - Rollback: restore any earlier version. Corrections behind the lessons it removes are quarantined so
 *    the next run does not simply learn them again; restoring a version releases its lessons' corrections.
 */

export type CorrectionKind = 'decision' | 'task' | 'question' | 'speaker';
export type CorrectionAction = 'edit' | 'delete' | 'add';

export interface CorrectionRow {
  _id?: Types.ObjectId;
  hostId: string;
  meetingCode: string;
  sessionId: string;
  kind: CorrectionKind;
  action: CorrectionAction;
  /** Edited field (status, owner, dueDate, statement, task, speakerName …); null for add/delete. */
  field: string | null;
  itemId: string | null;
  before: unknown;
  after: unknown;
  /** Transcript lines the original item cited, so the dataset can be replayed. */
  evidence: Array<{ seq: number; speaker: string; text: string }>;
  by: string;
  at: Date;
  /** Marked wrong by a person: never used for learning. */
  excluded?: boolean;
  /** Set by a rollback to that version: not used for learning until a version needing it is restored. */
  quarantinedBy?: number | null;
}

export const corrections = () => mongoose.connection.collection<CorrectionRow>('ai_corrections');
export const lessonsCol = () => mongoose.connection.collection<LessonsDoc>('ai_lessons');
const profiles = () => mongoose.connection.collection<{ _id: string } & Record<string, unknown>>('ai_profiles');

// ---------- policy (data, not code) ----------

export const LearningPolicy = z.object({
  /** Distinct corrections a lesson needs before it is applied. */
  minCorrections: z.number().int().min(1).max(100),
  /** …from at least this many different meetings. */
  minSessions: z.number().int().min(1).max(50),
  /** …made by at least this many different people. */
  minPeople: z.number().int().min(1).max(20),
  /** The model's own confidence in the generalisation, 0–1. */
  minConfidence: z.number().min(0).max(1),
  /** Only corrections from the last N days count, so lessons expire unless reinforced. */
  windowDays: z.number().int().min(1).max(3650),
  maxLessons: z.number().int().min(1).max(50),
  /** Versions kept for rollback. */
  maxVersions: z.number().int().min(2).max(500),
});
export type LearningPolicy = z.infer<typeof LearningPolicy>;

const POLICY_ID = 'learning-policy';

/** Fill an empty database with the seed policy; settings added later are filled in, edits are kept. */
export async function ensureLearningPolicy(): Promise<void> {
  const seed = LearningPolicy.parse(policySeed);
  const doc = await profiles().findOne({ _id: POLICY_ID });
  const { _id: _ignored, ...stored } = (doc ?? {}) as Record<string, unknown>;
  if (doc && LearningPolicy.safeParse(stored).success) return;
  const merged = LearningPolicy.safeParse({ ...seed, ...stored });
  await profiles().replaceOne({ _id: POLICY_ID }, merged.success ? merged.data : seed, { upsert: true });
}

/** System policy, with the host's overrides on top. */
export async function learningPolicy(hostId: string): Promise<{ system: LearningPolicy; host: Partial<LearningPolicy>; effective: LearningPolicy }> {
  let doc = await profiles().findOne({ _id: POLICY_ID });
  if (!doc) {
    await ensureLearningPolicy();
    doc = await profiles().findOne({ _id: POLICY_ID });
  }
  const { _id: _ignored, ...stored } = (doc ?? {}) as Record<string, unknown>;
  const system = LearningPolicy.safeParse(stored).success ? LearningPolicy.parse(stored) : LearningPolicy.parse(policySeed);
  const lessons = await lessonsCol().findOne({ _id: hostId }, { projection: { policy: 1 } });
  const host = LearningPolicy.partial().safeParse(lessons?.policy ?? {});
  const hostPolicy = host.success ? host.data : {};
  return { system, host: hostPolicy, effective: { ...system, ...hostPolicy } };
}

// ---------- lessons & versions ----------

export type LessonStatus = 'active' | 'candidate' | 'off';

export interface Lesson {
  id: string;
  text: string;
  /** What it is about: decision, task, owner, deadline, speaker, question … */
  topic: string;
  status: LessonStatus;
  /** Why it is (not) active, e.g. "needs corrections from 2 meetings (has 1)". */
  reason: string;
  /** The model's confidence in the generalisation. */
  confidence: number;
  support: { corrections: number; sessions: number; people: number };
  /** Correction ids it generalises (support counts only those still usable). */
  evidence: string[];
  /** Correction ids that go against it. */
  contradictedBy: string[];
  /** Version in which it first appeared. */
  since: number;
}

export interface LessonVersion {
  version: number;
  createdAt: Date;
  source: 'learn' | 'rollback' | 'toggle' | 'exclude' | 'policy';
  /** For a rollback: the version restored. */
  fromVersion?: number;
  by?: string | null;
  note: string;
  /** Corrections considered by a learning run. */
  basedOn: number;
  lessons: Lesson[];
}

export interface LessonsDoc {
  _id: string; // host id
  current: number;
  versions: LessonVersion[];
  /** Lesson texts the host switched off; never applied or proposed again. */
  disabled: string[];
  policy?: Partial<LearningPolicy>;
  updatedAt: Date;
  /** Set when a person excluded a correction, so the worker re-learns. */
  relearnRequested?: boolean;
}

const key = (t: string) => t.trim().toLowerCase().replace(/\s+/g, ' ');

/** Normalise a stored document (older format: a flat, unchecked `lessons` list → candidates only). */
async function loadDoc(hostId: string): Promise<LessonsDoc | null> {
  const raw = (await lessonsCol().findOne({ _id: hostId })) as (LessonsDoc & { lessons?: Array<{ text: string; topic?: string }> }) | null;
  if (!raw) return null;
  if (Array.isArray(raw.versions)) return raw;
  const lessons: Lesson[] = (raw.lessons ?? []).map((l, i) => ({
    id: `L${i + 1}`, text: l.text, topic: l.topic ?? 'other', status: 'candidate', reason: 'learned before evidence checks; waiting for new evidence',
    confidence: 0, support: { corrections: 0, sessions: 0, people: 0 }, evidence: [], contradictedBy: [], since: 1,
  }));
  const doc: LessonsDoc = {
    _id: hostId, current: 1, disabled: raw.disabled ?? [], updatedAt: raw.updatedAt ?? new Date(0),
    versions: [{ version: 1, createdAt: raw.updatedAt ?? new Date(0), source: 'learn', note: 'Migrated', basedOn: 0, lessons }],
  };
  await lessonsCol().replaceOne({ _id: hostId }, doc);
  return doc;
}

export function currentVersion(doc: LessonsDoc | null): LessonVersion | null {
  return doc?.versions.find((v) => v.version === doc.current) ?? null;
}

/** Only these reach the note-taker. */
export function appliedLessons(doc: LessonsDoc | null): string[] {
  return (currentVersion(doc)?.lessons ?? []).filter((l) => l.status === 'active').map((l) => l.text);
}

/** Corrections that may count as evidence: in the window, not excluded, not quarantined, not undone later. */
export async function usableCorrections(hostId: string, policy: LearningPolicy, now = new Date(), limit = 300): Promise<CorrectionRow[]> {
  const since = new Date(now.getTime() - policy.windowDays * 86_400_000);
  const rows = await corrections()
    .find({ hostId, at: { $gte: since }, excluded: { $ne: true }, quarantinedBy: { $not: { $gt: 0 } } })
    .sort({ at: -1 })
    .limit(limit)
    .toArray();
  return dropReverted(rows);
}

/**
 * A correction that was undone later is noise, not a lesson: an edit set back to its original value,
 * or an item added and then deleted again. Both sides are dropped.
 */
export function dropReverted(rows: CorrectionRow[]): CorrectionRow[] {
  const chrono = [...rows].sort((a, b) => +a.at - +b.at);
  const drop = new Set<CorrectionRow>();
  const same = (x: unknown, y: unknown) => JSON.stringify(x ?? null) === JSON.stringify(y ?? null);
  for (let i = 0; i < chrono.length; i++) {
    const a = chrono[i]!;
    if (drop.has(a)) continue;
    for (let j = i + 1; j < chrono.length; j++) {
      const b = chrono[j]!;
      if (drop.has(b) || b.sessionId !== a.sessionId || b.kind !== a.kind) continue;
      const undoneEdit = a.action === 'edit' && b.action === 'edit' && a.itemId === b.itemId && a.field === b.field && same(b.after, a.before);
      const undoneAdd = a.action === 'add' && b.action === 'delete' && !!a.itemId && a.itemId === b.itemId;
      const undoneSpeaker = a.kind === 'speaker' && b.kind === 'speaker' && same(a.before, b.after) && same(a.after, b.before);
      if (undoneEdit || undoneAdd || undoneSpeaker) {
        drop.add(a);
        drop.add(b);
        break;
      }
    }
  }
  return rows.filter((r) => !drop.has(r));
}

/** Support and status of a lesson from the corrections that actually exist. */
export function evaluateLesson(
  l: Pick<Lesson, 'confidence'> & { evidence: string[]; contradictedBy: string[] },
  rowsById: Map<string, CorrectionRow>,
  policy: LearningPolicy,
  disabled: boolean,
): Pick<Lesson, 'status' | 'reason' | 'support' | 'evidence' | 'contradictedBy'> {
  // The cited list is kept as is (so a correction marked wrong can be restored); only usable ones count.
  const ev = [...new Set(l.evidence)];
  const against = [...new Set(l.contradictedBy)].filter((id) => !ev.includes(id));
  const rows = ev.filter((id) => rowsById.has(id)).map((id) => rowsById.get(id)!);
  const countedAgainst = against.filter((id) => rowsById.has(id));
  const support = { corrections: rows.length, sessions: new Set(rows.map((r) => r.sessionId)).size, people: new Set(rows.map((r) => r.by)).size };
  const missing: string[] = [];
  if (support.corrections < policy.minCorrections) missing.push(`${policy.minCorrections} corrections (has ${support.corrections})`);
  if (support.sessions < policy.minSessions) missing.push(`corrections from ${policy.minSessions} meetings (has ${support.sessions})`);
  if (support.people < policy.minPeople) missing.push(`corrections by ${policy.minPeople} people (has ${support.people})`);
  if (l.confidence < policy.minConfidence) missing.push(`confidence ${policy.minConfidence} (has ${round2(l.confidence)})`);
  let status: LessonStatus = 'active';
  let reason = 'Meets the learning policy';
  if (disabled) {
    status = 'off';
    reason = 'Switched off';
  } else if (countedAgainst.length) {
    status = 'candidate';
    reason = `${countedAgainst.length} ${countedAgainst.length === 1 ? 'correction goes' : 'corrections go'} against it`;
  } else if (missing.length) {
    status = 'candidate';
    reason = `Needs ${missing.join(', ')}`;
  }
  return { status, reason, support, evidence: ev, contradictedBy: against };
}

const round2 = (n: number) => Math.round(n * 100) / 100;
const idOf = (r: CorrectionRow) => String(r._id);

async function rowsByIds(hostId: string, ids: string[]): Promise<Map<string, CorrectionRow>> {
  const valid = [...new Set(ids)].filter((id) => Types.ObjectId.isValid(id)).map((id) => new Types.ObjectId(id));
  if (!valid.length) return new Map();
  const rows = await corrections().find({ hostId, _id: { $in: valid } }).toArray();
  return new Map(rows.map((r) => [idOf(r), r]));
}

/** Store a new version (and keep only the newest `maxVersions`). */
async function pushVersion(hostId: string, doc: LessonsDoc | null, v: Omit<LessonVersion, 'version' | 'createdAt'>, policy: LearningPolicy, now: Date, extra: Partial<LessonsDoc> = {}): Promise<LessonsDoc> {
  const version = Math.max(0, ...(doc?.versions ?? []).map((x) => x.version)) + 1;
  const versions = [...(doc?.versions ?? []), { ...v, version, createdAt: now }].slice(-policy.maxVersions);
  const next: LessonsDoc = {
    _id: hostId,
    current: version,
    versions,
    disabled: doc?.disabled ?? [],
    ...(doc?.policy ? { policy: doc.policy } : {}),
    updatedAt: now,
    ...extra,
  };
  await lessonsCol().replaceOne({ _id: hostId }, next, { upsert: true });
  return next;
}

const sameLessons = (a: Lesson[], b: Lesson[]) =>
  JSON.stringify(a.map((l) => [key(l.text), l.status, l.evidence.length]).sort()) === JSON.stringify(b.map((l) => [key(l.text), l.status, l.evidence.length]).sort());

// ---------- recording corrections ----------

async function evidenceLines(sessionId: string, seqs: number[] | undefined) {
  if (!seqs?.length) return [];
  const rows = await TranscriptLineModel.find({ sessionId, seq: { $in: seqs.slice(0, 12) } })
    .sort({ seq: 1 })
    .select({ _id: 0, seq: 1, speakerName: 1, text: 1 })
    .lean();
  return rows.map((r) => ({ seq: r.seq ?? 0, speaker: r.speakerName ?? '', text: r.text ?? '' }));
}

/** Store corrections (one per changed field). Never throws: feedback must not break an edit. */
export async function recordCorrections(
  base: Pick<CorrectionRow, 'hostId' | 'meetingCode' | 'sessionId' | 'kind' | 'by'> & { itemId: string | null; evidenceSeqs?: number[] },
  changes: Array<{ action: CorrectionAction; field?: string | null; before: unknown; after: unknown }>,
): Promise<void> {
  const real = changes.filter((c) => c.action !== 'edit' || JSON.stringify(c.before ?? null) !== JSON.stringify(c.after ?? null));
  if (!real.length) return;
  try {
    const evidence = await evidenceLines(base.sessionId, base.evidenceSeqs);
    const at = new Date();
    await corrections().insertMany(
      real.map((c) => ({
        hostId: base.hostId,
        meetingCode: base.meetingCode,
        sessionId: base.sessionId,
        kind: base.kind,
        action: c.action,
        field: c.field ?? null,
        itemId: base.itemId,
        before: c.before ?? null,
        after: c.after ?? null,
        evidence,
        by: base.by,
        at,
      })),
    );
  } catch (err) {
    logger.warn({ err }, 'could not record a correction');
  }
}

/** Recurring mistakes: corrections grouped by what was wrong. */
export async function feedbackStats(hostId: string) {
  const groups = await corrections()
    .aggregate<{ _id: { kind: string; action: string; field: string | null }; n: number; last: Date }>([
      { $match: { hostId, excluded: { $ne: true } } },
      { $group: { _id: { kind: '$kind', action: '$action', field: '$field' }, n: { $sum: 1 }, last: { $max: '$at' } } },
      { $sort: { n: -1, last: -1, '_id.kind': 1, '_id.field': 1 } },
    ])
    .toArray();
  const [excluded, quarantined] = await Promise.all([
    corrections().countDocuments({ hostId, excluded: true }),
    corrections().countDocuments({ hostId, quarantinedBy: { $gt: 0 } }),
  ]);
  return {
    total: groups.reduce((t, g) => t + g.n, 0),
    excluded,
    quarantined,
    mistakes: groups.map((g) => ({ kind: g._id.kind, action: g._id.action, field: g._id.field, count: g.n, lastAt: g.last })),
  };
}

// ---------- learning ----------

export const LessonsOutput = z.object({
  lessons: z
    .array(
      z.object({
        text: z.string().describe('One instruction for the note-taker, general (not about one meeting), e.g. "Only record a task when someone takes it on"'),
        topic: z.string().describe('decision, task, owner, deadline, speaker, question, risk or other'),
        basedOn: z.array(z.number().int()).describe('Numbers of the corrections this lesson generalises'),
        contradictedBy: z.array(z.number().int()).describe('Numbers of corrections that go AGAINST this lesson (people corrected in the opposite direction)'),
        confidence: z.number().describe('0–1: how sure you are this is a real, general pattern and not a one-off or a mistaken correction'),
      }),
    )
    .describe('Lessons, most important first'),
});

export const LESSONS_SYSTEM = `You improve an AI note-taker for team meetings. You get the corrections people made to its notes:
what the AI wrote, what people changed it to (or that they deleted it / added something it missed), and the transcript
lines it was based on. Find RECURRING mistakes and write short, general instructions that would have prevented them.
- Cite in basedOn exactly the corrections each lesson generalises, and in contradictedBy any that point the other way.
- People sometimes correct wrongly. A single correction, or corrections that disagree with each other or with the
  transcript, deserve low confidence. Patterns repeated across different meetings deserve high confidence.
- Never mention specific meetings, people or dates. Keep useful existing lessons (reword or merge if needed) when the
  corrections still support them; drop the rest. Never propose a lesson the team switched off.`;

function lessonsPrompt(rows: CorrectionRow[], current: LessonVersion | null, disabled: string[]): string {
  const lines = rows.map((r, i) => {
    const ev = r.evidence.map((e) => `    "${e.speaker}: ${e.text}"`).join('\n');
    const what =
      r.action === 'delete'
        ? `DELETED ${r.kind}: ${JSON.stringify(r.before)}`
        : r.action === 'add'
          ? `MISSED ${r.kind}, added by a person: ${JSON.stringify(r.after)}`
          : `${r.kind}.${r.field}: AI wrote ${JSON.stringify(r.before)} → corrected to ${JSON.stringify(r.after)}`;
    return `[${i + 1}] (meeting ${r.sessionId.slice(-6)}) ${what}${ev ? `\n  based on:\n${ev}` : ''}`;
  });
  return [
    current?.lessons.length ? `CURRENT LESSONS:\n${current.lessons.filter((l) => l.status !== 'off').map((l) => `- ${l.text}`).join('\n')}` : 'CURRENT LESSONS: none',
    disabled.length ? `SWITCHED OFF BY THE TEAM (never propose):\n${disabled.map((d) => `- ${d}`).join('\n')}` : '',
    '',
    'CORRECTIONS (newest first):',
    lines.join('\n'),
  ]
    .filter(Boolean)
    .join('\n');
}

/** Re-derive a host's lessons from recent, usable corrections. Writes a new version only when something changed. */
export async function learnLessons(hostId: string, ai: AiClient, now = new Date(), by: string | null = null): Promise<LessonsDoc | null> {
  const { effective: policy } = await learningPolicy(hostId);
  const doc = await loadDoc(hostId);
  const current = currentVersion(doc);
  const rows = await usableCorrections(hostId, policy, now);
  const disabled = doc?.disabled ?? [];
  const off = new Set(disabled.map(key));

  let lessons: Lesson[] = [];
  if (rows.length) {
    const out = await ai.structured(LessonsOutput, { system: LESSONS_SYSTEM, prompt: lessonsPrompt(rows, current, disabled), temperature: 0.2 });
    const byIndex = (ns: number[]) => ns.filter((n) => n >= 1 && n <= rows.length).map((n) => idOf(rows[n - 1]!));
    const byId = new Map(rows.map((r) => [idOf(r), r]));
    const prevByText = new Map((current?.lessons ?? []).map((l) => [key(l.text), l]));
    let nextId = Math.max(0, ...(doc?.versions ?? []).flatMap((v) => v.lessons.map((l) => Number(l.id.slice(1)) || 0))) + 1;
    const seen = new Set<string>();
    for (const l of out.lessons) {
      const text = l.text.trim();
      const k = key(text);
      if (!text || seen.has(k) || off.has(k)) continue;
      seen.add(k);
      const confidence = Math.min(1, Math.max(0, Number.isFinite(l.confidence) ? l.confidence : 0));
      const prev = prevByText.get(k);
      const evald = evaluateLesson({ confidence, evidence: byIndex(l.basedOn), contradictedBy: byIndex(l.contradictedBy) }, byId, policy, false);
      if (!evald.support.corrections) continue; // a lesson must rest on at least one real correction
      lessons.push({
        id: prev?.id ?? `L${nextId++}`,
        text,
        topic: l.topic.trim() || 'other',
        confidence: round2(confidence),
        since: prev?.since ?? Math.max(0, ...(doc?.versions ?? []).map((v) => v.version)) + 1,
        ...evald,
      });
    }
    // Active first, then by evidence.
    lessons = lessons
      .sort((a, b) => Number(b.status === 'active') - Number(a.status === 'active') || b.support.corrections - a.support.corrections)
      .slice(0, policy.maxLessons);
  }

  if (current && sameLessons(current.lessons.filter((l) => l.status !== 'off'), lessons)) {
    await lessonsCol().updateOne({ _id: hostId }, { $set: { updatedAt: now }, $unset: { relearnRequested: 1 } });
    return loadDoc(hostId);
  }
  if (!current && !lessons.length) return null;
  const active = lessons.filter((l) => l.status === 'active').length;
  return pushVersion(
    hostId,
    doc,
    { source: 'learn', by, basedOn: rows.length, lessons, note: `${active} applied, ${lessons.length - active} waiting for more evidence` },
    policy,
    now,
    { relearnRequested: undefined },
  );
}

/**
 * Go back to an earlier version. Its lessons are re-checked against today's evidence. Corrections behind lessons
 * that the rollback removes are quarantined (so they are not immediately re-learned); corrections behind the
 * restored lessons are released.
 */
export async function rollbackLessons(hostId: string, toVersion: number, by: string, now = new Date()): Promise<LessonsDoc> {
  const doc = await loadDoc(hostId);
  const target = doc?.versions.find((v) => v.version === toVersion);
  if (!doc || !target) throw Object.assign(new Error('Version not found'), { status: 404 });
  if (toVersion === doc.current) return doc;
  const { effective: policy } = await learningPolicy(hostId);
  const current = currentVersion(doc);
  const keep = new Set(target.lessons.map((l) => key(l.text)));
  const removed = (current?.lessons ?? []).filter((l) => !keep.has(key(l.text)));
  const restoredEvidence = target.lessons.flatMap((l) => l.evidence);
  const newVersion = Math.max(...doc.versions.map((v) => v.version)) + 1;

  const toQuarantine = removed.flatMap((l) => l.evidence).filter((id) => !restoredEvidence.includes(id));
  const oid = (ids: string[]) => ids.filter((id) => Types.ObjectId.isValid(id)).map((id) => new Types.ObjectId(id));
  if (toQuarantine.length) await corrections().updateMany({ hostId, _id: { $in: oid(toQuarantine) } }, { $set: { quarantinedBy: newVersion } });
  if (restoredEvidence.length) await corrections().updateMany({ hostId, _id: { $in: oid(restoredEvidence) } }, { $set: { quarantinedBy: null } });

  // Re-check the restored lessons against the evidence that counts today (window, exclusions).
  const usable = new Map((await usableCorrections(hostId, policy, now)).map((r) => [idOf(r), r]));
  const off = new Set(doc.disabled.map(key));
  const lessons = target.lessons.map((l) => ({ ...l, ...evaluateLesson(l, usable, policy, off.has(key(l.text))) }));
  return pushVersion(
    hostId,
    doc,
    { source: 'rollback', fromVersion: toVersion, by, basedOn: usable.size, lessons, note: `Restored version ${toVersion}; ${removed.length} lesson(s) removed` },
    policy,
    now,
  );
}

/** Switch one lesson off (never applied or proposed again) or back on (re-checked against the policy). */
export async function toggleLesson(hostId: string, lessonId: string, on: boolean, by: string, now = new Date()): Promise<LessonsDoc> {
  const doc = await loadDoc(hostId);
  const current = currentVersion(doc);
  const lesson = current?.lessons.find((l) => l.id === lessonId);
  if (!doc || !current || !lesson) throw Object.assign(new Error('Lesson not found'), { status: 404 });
  const { effective: policy } = await learningPolicy(hostId);
  const disabled = on ? doc.disabled.filter((d) => key(d) !== key(lesson.text)) : [...new Set([...doc.disabled, lesson.text])];
  const usable = new Map((await usableCorrections(hostId, policy, now)).map((r) => [idOf(r), r]));
  const lessons = current.lessons.map((l) => (l.id === lessonId ? { ...l, ...evaluateLesson(l, usable, policy, !on) } : l));
  return pushVersion(
    hostId,
    { ...doc, disabled },
    { source: 'toggle', by, basedOn: usable.size, lessons, note: `${on ? 'Turned on' : 'Turned off'}: ${lesson.text}` },
    policy,
    now,
  );
}

/**
 * A person says a correction was itself wrong (or right after all). Lessons are re-checked immediately without it,
 * and the worker re-learns.
 */
export async function setCorrectionExcluded(hostId: string, correctionId: string, excluded: boolean, by: string, now = new Date()): Promise<LessonsDoc | null> {
  if (!Types.ObjectId.isValid(correctionId)) throw Object.assign(new Error('Correction not found'), { status: 404 });
  const r = await corrections().updateOne({ hostId, _id: new Types.ObjectId(correctionId) }, { $set: { excluded } });
  if (r.matchedCount === 0) throw Object.assign(new Error('Correction not found'), { status: 404 });
  const doc = await loadDoc(hostId);
  const current = currentVersion(doc);
  if (!doc || !current) return doc;
  const { effective: policy } = await learningPolicy(hostId);
  const usable = new Map((await usableCorrections(hostId, policy, now)).map((x) => [idOf(x), x]));
  const off = new Set(doc.disabled.map(key));
  const lessons = current.lessons.map((l) => ({ ...l, ...evaluateLesson(l, usable, policy, off.has(key(l.text))) }));
  return pushVersion(
    hostId,
    doc,
    { source: 'exclude', by, basedOn: usable.size, lessons, note: `${excluded ? 'Marked a correction as wrong' : 'Restored a correction'}` },
    policy,
    now,
    { relearnRequested: true },
  );
}

/** Re-check the current lessons against today's evidence and policy (e.g. after the thresholds changed). */
export async function recheckLessons(hostId: string, by: string, now = new Date()): Promise<LessonsDoc | null> {
  const doc = await loadDoc(hostId);
  const current = currentVersion(doc);
  if (!doc || !current) return doc;
  const { effective: policy } = await learningPolicy(hostId);
  const usable = new Map((await usableCorrections(hostId, policy, now)).map((x) => [idOf(x), x]));
  const off = new Set(doc.disabled.map(key));
  const lessons = current.lessons.map((l) => ({ ...l, ...evaluateLesson(l, usable, policy, off.has(key(l.text))) }));
  if (JSON.stringify(lessons.map((l) => [l.status, l.reason])) === JSON.stringify(current.lessons.map((l) => [l.status, l.reason]))) return doc;
  const active = lessons.filter((l) => l.status === 'active').length;
  return pushVersion(hostId, doc, { source: 'policy', by, basedOn: usable.size, lessons, note: `Thresholds changed: ${active} applied` }, policy, now);
}

/** What the account page shows: current lessons with their evidence, and the version history. */
export async function lessonsView(hostId: string) {
  const [doc, policy] = await Promise.all([loadDoc(hostId), learningPolicy(hostId)]);
  const current = currentVersion(doc);
  const ids = (current?.lessons ?? []).flatMap((l) => [...l.evidence, ...l.contradictedBy]);
  const rows = await rowsByIds(hostId, ids);
  const brief = (id: string) => {
    const r = rows.get(id);
    return r
      ? { id, kind: r.kind, action: r.action, field: r.field, before: r.before, after: r.after, at: r.at, sessionId: r.sessionId, excluded: !!r.excluded }
      : null;
  };
  return {
    policy,
    current: doc?.current ?? null,
    lessons: (current?.lessons ?? []).map((l) => ({
      ...l,
      evidenceDetail: l.evidence.map(brief).filter(Boolean),
      contradictedDetail: l.contradictedBy.map(brief).filter(Boolean),
    })),
    versions: [...(doc?.versions ?? [])].reverse().map((v) => ({
      version: v.version,
      createdAt: v.createdAt,
      source: v.source,
      fromVersion: v.fromVersion ?? null,
      note: v.note,
      active: v.lessons.filter((l) => l.status === 'active').length,
      candidates: v.lessons.filter((l) => l.status === 'candidate').length,
      lessons: v.lessons.map((l) => ({ id: l.id, text: l.text, status: l.status })),
    })),
    disabled: doc?.disabled ?? [],
    learnedAt: doc?.updatedAt ?? null,
  };
}

/** Hosts with corrections newer than their lessons, or who asked for a re-learn. */
export async function hostsToLearn(limit = 20): Promise<string[]> {
  const latest = await corrections()
    .aggregate<{ _id: string; last: Date }>([{ $group: { _id: '$hostId', last: { $max: '$at' } } }, { $sort: { last: -1 } }, { $limit: 500 }])
    .toArray();
  const docs = await lessonsCol()
    .find({})
    .project<{ _id: string; updatedAt: Date; relearnRequested?: boolean }>({ updatedAt: 1, relearnRequested: 1 })
    .toArray();
  const learnedAt = new Map(docs.map((d) => [d._id, d.updatedAt?.getTime?.() ?? 0]));
  const requested = docs.filter((d) => d.relearnRequested).map((d) => d._id);
  const stale = latest.filter((l) => (learnedAt.get(l._id) ?? 0) < l.last.getTime()).map((l) => l._id);
  return [...new Set([...requested, ...stale])].slice(0, limit);
}
