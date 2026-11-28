import type { Db } from 'mongodb';
import type { Carryover, EarlierItemRef, PastDecisionRef } from './intel/schema.js';

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
    risks?: Array<{ description: string; status: string; involves?: string[] }>;
  };
}

export interface Continuity {
  /** Open items of the most recent earlier session (null when nothing is open). */
  carryover: Carryover | null;
  /** Agreed decisions from earlier sessions, newest first, with prompt ids P1, P2, … */
  pastDecisions: PastDecisionRef[];
  /** Still-open tasks and risks from earlier sessions, with prompt ids E1, E2, … (repeated blockers, dependencies). */
  earlierItems: EarlierItemRef[];
}

const day = (d?: Date) => (d ? new Date(d).toISOString().slice(0, 10) : '');
const MAX_SESSIONS = 6;
const MAX_PAST_DECISIONS = 25;
const MAX_ITEMS = 8;
const MAX_EARLIER_ITEMS = 25;

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

  const earlierItems: EarlierItemRef[] = [];
  const seenItems = new Set<string>();
  const addEarlier = (item: Omit<EarlierItemRef, 'ref'>) => {
    const key = `${item.kind}:${item.text.trim().toLowerCase()}`;
    if (!item.text.trim() || seenItems.has(key) || earlierItems.length >= MAX_EARLIER_ITEMS) return;
    seenItems.add(key);
    earlierItems.push({ ref: `E${earlierItems.length + 1}`, ...item, text: item.text.trim() });
  };
  for (const r of sorted) {
    const meta = { date: day(r.startedAt), title: r.title ?? 'Earlier meeting' };
    for (const x of r.insights?.risks ?? []) {
      if (x.status === 'open') addEarlier({ kind: 'risk', text: x.description, owner: x.involves?.join(', ') || null, dueDate: null, ...meta });
    }
    for (const a of r.insights?.actionItems ?? []) {
      if (a.status === 'open') addEarlier({ kind: 'task', text: a.task, owner: a.owner ?? null, dueDate: a.dueDate ?? null, ...meta });
    }
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
  return { carryover, pastDecisions, earlierItems };
}

export async function loadContinuity(db: Db, meetingCodes: string[], currentSessionId: string, today = new Date()): Promise<Continuity> {
  if (meetingCodes.length === 0) return { carryover: null, pastDecisions: [], earlierItems: [] };
  const rows = (await db
    .collection('meeting_insights')
    .find({ meetingCode: { $in: meetingCodes }, sessionId: { $ne: currentSessionId } })
    .sort({ startedAt: -1 })
    .limit(MAX_SESSIONS)
    .project({ meetingCode: 1, sessionId: 1, title: 1, startedAt: 1, 'insights.decisions': 1, 'insights.actionItems': 1, 'insights.risks': 1 })
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

/**
 * Structured ledger of earlier sessions (same sources as above) for questions like "who owns the
 * pricing page?", "what did we decide on billing?", "what is still pending?". Newest first.
 */
export async function commitmentsLedger(db: Db, meetingCodes: string[], currentSessionId: string, maxSessions = 10): Promise<string> {
  if (meetingCodes.length === 0) return '';
  const rows = (await db
    .collection('meeting_insights')
    .find({ meetingCode: { $in: meetingCodes }, sessionId: { $ne: currentSessionId } })
    .sort({ startedAt: -1 })
    .limit(maxSessions)
    .project({ title: 1, startedAt: 1, 'insights.decisions': 1, 'insights.actionItems': 1, 'insights.risks': 1 })
    .toArray()) as unknown as Row[];
  const today = new Date().toISOString().slice(0, 10);
  const out: string[] = [];
  for (const r of rows) {
    const items: string[] = [];
    for (const d of r.insights?.decisions ?? []) {
      if (d.status !== 'rejected' && d.status !== 'superseded') items.push(`  decision [${d.status}]: ${d.statement}${d.options?.length && d.status !== 'agreed' ? ` (options: ${d.options.join(' vs ')})` : ''}`);
    }
    for (const a of r.insights?.actionItems ?? []) {
      const late = a.status === 'open' && a.dueDate && a.dueDate < today ? ' OVERDUE' : '';
      items.push(`  task [${a.status}${late}]: ${a.task} – owner ${a.owner ?? 'none'}${a.dueDate ? `, due ${a.dueDate}` : ''}`);
    }
    for (const x of r.insights?.risks ?? []) items.push(`  risk [${x.status}]: ${x.description}`);
    if (items.length) out.push(`${day(r.startedAt)} "${r.title ?? 'Meeting'}":\n${items.join('\n')}`);
  }
  return out.join('\n');
}
