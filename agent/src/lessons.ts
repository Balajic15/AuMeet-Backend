import type { Db } from 'mongodb';

/*
 * What the note-taker learned from people correcting its notes (`ai_lessons`, one document per host,
 * written by the server worker from `ai_corrections`). Plain sentences that go into the analyst prompt,
 * so recurring mistakes stop repeating without code changes.
 */

export interface LessonDoc {
  _id: string;
  lessons?: Array<{ text: string; active?: boolean }>;
}

export async function loadLessons(db: Db, hostId: string): Promise<string[]> {
  const doc = await db.collection<LessonDoc>('ai_lessons').findOne({ _id: hostId });
  return (doc?.lessons ?? []).filter((l) => l.active !== false && l.text?.trim()).map((l) => l.text.trim());
}
