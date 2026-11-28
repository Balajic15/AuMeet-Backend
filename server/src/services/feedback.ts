import mongoose from 'mongoose';
import { z } from 'zod';
import type { AiClient } from '../ai/gemini.js';
import { TranscriptLineModel } from '../models/Insights.js';

/*
 * Self-improving notes. Every time someone corrects the AI's notes (a wrong decision status, owner,
 * deadline or speaker, an item that shouldn't be there, one that was missed), the correction is stored
 * with the transcript lines the AI based it on (`ai_corrections`). That is the evaluation dataset.
 * The worker periodically turns a team's corrections into plain-language lessons (`ai_lessons`) that
 * the live note-taker reads on every run, so the same mistake isn't made again.
 */

export type CorrectionKind = 'decision' | 'task' | 'question' | 'speaker';
export type CorrectionAction = 'edit' | 'delete' | 'add';

export interface CorrectionRow {
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
}

export const corrections = () => mongoose.connection.collection<CorrectionRow>('ai_corrections');
export const lessonsCol = () => mongoose.connection.collection<LessonsDoc>('ai_lessons');

export interface Lesson {
  text: string;
  /** What it is about: decision, task, owner, deadline, speaker, question … */
  topic: string;
  /** How many corrections support it. */
  support: number;
  active: boolean;
}

export interface LessonsDoc {
  _id: string; // host id
  lessons: Lesson[];
  /** Lessons the host switched off; never proposed again. */
  disabled: string[];
  learnedFrom: number;
  updatedAt: Date;
}

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
  } catch {
    /* best effort */
  }
}

/** Recurring mistakes: corrections grouped by what was wrong. */
export async function feedbackStats(hostId: string) {
  const groups = await corrections()
    .aggregate<{ _id: { kind: string; action: string; field: string | null }; n: number; last: Date }>([
      { $match: { hostId } },
      { $group: { _id: { kind: '$kind', action: '$action', field: '$field' }, n: { $sum: 1 }, last: { $max: '$at' } } },
      { $sort: { n: -1 } },
    ])
    .toArray();
  const total = groups.reduce((t, g) => t + g.n, 0);
  return {
    total,
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
        support: z.number().int().describe('How many of the corrections this lesson explains'),
      }),
    )
    .describe('At most 12 lessons, most important first'),
});

export const LESSONS_SYSTEM = `You improve an AI note-taker for team meetings. You get the corrections people made to its
notes: what the AI wrote, what people changed it to (or that they deleted it / added something it missed), and
the transcript lines it was based on. Find the RECURRING mistakes and write short, general instructions that
would have prevented them. Prefer patterns that several corrections share; a single correction only counts when
the rule behind it is unmistakable. Never mention specific meetings, people or dates. Keep useful existing lessons
(reword or merge them if needed), drop ones the corrections no longer support, and never re-propose a lesson the
team switched off.`;

function lessonsPrompt(rows: CorrectionRow[], current: LessonsDoc | null): string {
  const lines = rows.map((r, i) => {
    const ev = r.evidence.map((e) => `    "${e.speaker}: ${e.text}"`).join('\n');
    const what =
      r.action === 'delete'
        ? `DELETED ${r.kind}: ${JSON.stringify(r.before)}`
        : r.action === 'add'
          ? `MISSED ${r.kind}, added by a person: ${JSON.stringify(r.after)}`
          : `${r.kind}.${r.field}: AI wrote ${JSON.stringify(r.before)} → corrected to ${JSON.stringify(r.after)}`;
    return `[${i + 1}] ${what}${ev ? `\n  based on:\n${ev}` : ''}`;
  });
  return [
    current?.lessons.length ? `CURRENT LESSONS:\n${current.lessons.map((l) => `- ${l.text}`).join('\n')}` : 'CURRENT LESSONS: none',
    current?.disabled.length ? `SWITCHED OFF BY THE TEAM (never propose):\n${current.disabled.map((d) => `- ${d}`).join('\n')}` : '',
    '',
    'CORRECTIONS (newest first):',
    lines.join('\n'),
  ]
    .filter(Boolean)
    .join('\n');
}

/** Re-derive a host's lessons from their recent corrections. */
export async function learnLessons(hostId: string, ai: AiClient, now = new Date(), maxCorrections = 200): Promise<LessonsDoc | null> {
  const rows = await corrections().find({ hostId }).sort({ at: -1 }).limit(maxCorrections).toArray();
  if (!rows.length) return null;
  const current = await lessonsCol().findOne({ _id: hostId });
  const out = await ai.structured(LessonsOutput, { system: LESSONS_SYSTEM, prompt: lessonsPrompt(rows, current), temperature: 0.2 });
  const disabled = current?.disabled ?? [];
  const off = new Set(disabled.map((d) => d.trim().toLowerCase()));
  const seen = new Set<string>();
  const lessons: Lesson[] = [];
  for (const l of out.lessons) {
    const text = l.text.trim();
    const key = text.toLowerCase();
    if (!text || off.has(key) || seen.has(key)) continue;
    seen.add(key);
    lessons.push({ text, topic: l.topic.trim() || 'other', support: Math.max(0, l.support), active: true });
  }
  const doc: LessonsDoc = { _id: hostId, lessons: lessons.slice(0, 12), disabled, learnedFrom: rows.length, updatedAt: now };
  await lessonsCol().replaceOne({ _id: hostId }, doc, { upsert: true });
  return doc;
}

/** Hosts with corrections newer than their lessons. */
export async function hostsToLearn(limit = 20): Promise<string[]> {
  const latest = await corrections()
    .aggregate<{ _id: string; last: Date }>([{ $group: { _id: '$hostId', last: { $max: '$at' } } }, { $sort: { last: -1 } }, { $limit: 500 }])
    .toArray();
  if (!latest.length) return [];
  const docs = await lessonsCol()
    .find({ _id: { $in: latest.map((l) => l._id) } })
    .project<{ _id: string; updatedAt: Date }>({ updatedAt: 1 })
    .toArray();
  const learnedAt = new Map(docs.map((d) => [d._id, d.updatedAt.getTime()]));
  return latest.filter((l) => (learnedAt.get(l._id) ?? 0) < l.last.getTime()).map((l) => l._id).slice(0, limit);
}
