import type { Db } from 'mongodb';

/*
 * How a team reacted to the AI speaking up on its own (`ai_reactions`, one row per remark).
 * Keyed by the meeting's host, so a team's habits carry over to its next meetings.
 */

export type Reaction = 'engaged' | 'ignored' | 'rejected';

export interface ReactionRow {
  hostId: string;
  meetingCode: string;
  sessionId: string;
  intent: string;
  reaction: Reaction;
  message: string;
  at: Date;
}

export interface IntentStats {
  intent: string;
  engaged: number;
  ignored: number;
  rejected: number;
}

export async function recordReaction(db: Db, row: ReactionRow): Promise<void> {
  await db.collection('ai_reactions').insertOne(row);
}

/** Recent reactions for this host, grouped by what the AI was trying to do. */
export async function loadLearning(db: Db, hostId: string, limit = 400): Promise<IntentStats[]> {
  const rows = await db
    .collection('ai_reactions')
    .find({ hostId })
    .sort({ at: -1 })
    .limit(limit)
    .project({ intent: 1, reaction: 1 })
    .toArray();
  return summarise(rows as unknown as Array<Pick<ReactionRow, 'intent' | 'reaction'>>);
}

export function summarise(rows: Array<Pick<ReactionRow, 'intent' | 'reaction'>>): IntentStats[] {
  const by = new Map<string, IntentStats>();
  for (const r of rows) {
    const s = by.get(r.intent) ?? { intent: r.intent, engaged: 0, ignored: 0, rejected: 0 };
    s[r.reaction]++;
    by.set(r.intent, s);
  }
  return [...by.values()].sort((a, b) => b.engaged + b.ignored + b.rejected - (a.engaged + a.ignored + a.rejected));
}

export function renderLearning(stats: IntentStats[]): string {
  if (!stats.length) return '';
  return (
    'HOW THIS TEAM REACTED TO YOUR EARLIER REMARKS (past meetings; lean towards what they engaged with, ' +
    'and away from what they ignored or pushed back on):\n' +
    stats.map((s) => `- ${s.intent}: engaged ${s.engaged}, ignored ${s.ignored}, pushed back ${s.rejected}`).join('\n')
  );
}
