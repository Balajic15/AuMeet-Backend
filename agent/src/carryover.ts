import type { Db } from 'mongodb';
import type { Carryover, PastDecisionRef } from './intel/schema.js';

/*
 * Continuity between meetings. Sources, both chosen by the host:
 *  - earlier sessions of this same meeting link (e.g. a weekly stand-up)
 *  - the meeting this one follows up on (Prepare → "Follow-up to"), which the host also hosts
 * Never other people's meetings: the people in this room may not have been in those.
 */

interface Row {
  meetingCode: string;
  sessionId: string;
  title?: string;
  startedAt?: Date;
  insights?: {
    decisions?: Array<{ statement: string; status: string; options?: string[] }>;
    actionItems?: Array<{ task: string; owner: string | null; dueDate: string | null; status: string }>;
  };
}

export interface Continuity {
  /** Open items of the most recent earlier session (null when nothing is open). */
  carryover: Carryover | null;
  /** Agreed decisions from earlier sessions, newest first, with prompt ids P1, P2, … */
  pastDecisions: PastDecisionRef[];
}

const day = (d?: Date) => (d ? new Date(d).toISOString().slice(0, 10) : '');
const MAX_SESSIONS = 6;
const MAX_PAST_DECISIONS = 25;
const MAX_ITEMS = 8;

export function buildContinuity(rows: Row[], today: Date): Continuity {
  const sorted = [...rows].sort((a, b) => (b.startedAt?.getTime() ?? 0) - (a.startedAt?.getTime() ?? 0));

  const pastDecisions: PastDecisionRef[] = [];
  const seen = new Set<string>();
  for (const r of sorted) {
    for (const d of r.insights?.decisions ?? []) {
      const key = d.statement.trim().toLowerCase();
      if (d.status !== 'agreed' || !key || seen.has(key)) continue;
      seen.add(key);
      pastDecisions.push({ ref: `P${pastDecisions.length + 1}`, statement: d.statement.trim(), date: day(r.startedAt), title: r.title ?? 'Earlier meeting' });
      if (pastDecisions.length >= MAX_PAST_DECISIONS) break;
    }
    if (pastDecisions.length >= MAX_PAST_DECISIONS) break;
  }

  const last = sorted[0];
  let carryover: Carryover | null = null;
  if (last) {
    const todayStr = today.toISOString().slice(0, 10);
    const decisions = (last.insights?.decisions ?? [])
      .filter((d) => d.status === 'disputed' || d.status === 'proposed')
      .slice(0, MAX_ITEMS)
      .map((d) => ({ statement: d.statement, options: d.options ?? [] }));
    const tasks = (last.insights?.actionItems ?? [])
      .filter((a) => a.status === 'open')
      .slice(0, MAX_ITEMS)
      .map((a) => ({ task: a.task, owner: a.owner ?? null, dueDate: a.dueDate ?? null, overdue: !!a.dueDate && a.dueDate < todayStr }));
    if (decisions.length || tasks.length) {
      carryover = { fromTitle: last.title ?? 'Previous meeting', fromDate: day(last.startedAt), decisions, tasks };
    }
  }
  return { carryover, pastDecisions };
}

export async function loadContinuity(db: Db, meetingCodes: string[], currentSessionId: string, today = new Date()): Promise<Continuity> {
  if (meetingCodes.length === 0) return { carryover: null, pastDecisions: [] };
  const rows = (await db
    .collection('meeting_insights')
    .find({ meetingCode: { $in: meetingCodes }, sessionId: { $ne: currentSessionId } })
    .sort({ startedAt: -1 })
    .limit(MAX_SESSIONS)
    .project({ meetingCode: 1, sessionId: 1, title: 1, startedAt: 1, 'insights.decisions': 1, 'insights.actionItems': 1 })
    .toArray()) as unknown as Row[];
  return buildContinuity(rows, today);
}

/** Instructions block for the voice assistant. */
export function renderCarryover(c: Carryover | null): string {
  if (!c) return '';
  const lines = [`LEFT OPEN AT THE PREVIOUS MEETING ("${c.fromTitle}", ${c.fromDate || 'earlier'}) – follow up on these:`];
  for (const d of c.decisions) lines.push(`- Undecided: ${d.statement}${d.options.length ? ` (options: ${d.options.join(' vs ')})` : ''}`);
  for (const t of c.tasks) {
    lines.push(`- Task: ${t.task} – ${t.owner ?? 'no owner'}${t.dueDate ? `, due ${t.dueDate}${t.overdue ? ' (OVERDUE)' : ''}` : ''}`);
  }
  return lines.join('\n');
}

/** A virtual agenda item so follow-ups are tracked like the rest of the agenda. */
export const FOLLOW_UP_ITEM = { id: 'followups', title: 'Follow-ups from last meeting', minutes: null as number | null };
