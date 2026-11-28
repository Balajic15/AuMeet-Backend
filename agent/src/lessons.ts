import type { Db } from 'mongodb';

/*
 * What the note-taker learned from people correcting its notes (`ai_lessons`, one document per host, written by
 * the server: server/src/services/feedback.ts). Lessons are versioned; only the CURRENT version's lessons with
 * status "active" are applied. Those met the learning policy (enough corrections, from enough meetings and people,
 * with enough confidence, and nothing against them). Candidates and switched-off lessons are never used, and
 * neither is the older unversioned format, whose lessons were never evidence-checked.
 */

export interface LessonDoc {
  _id: string;
  current?: number;
  versions?: Array<{ version: number; lessons: Array<{ text: string; status: 'active' | 'candidate' | 'off' }> }>;
}

export function activeLessons(doc: LessonDoc | null): string[] {
  const v = doc?.versions?.find((x) => x.version === doc.current);
  return (v?.lessons ?? []).filter((l) => l.status === 'active' && l.text?.trim()).map((l) => l.text.trim());
}

export async function loadLessons(db: Db, hostId: string): Promise<string[]> {
  return activeLessons(await db.collection<LessonDoc>('ai_lessons').findOne({ _id: hostId }));
}
