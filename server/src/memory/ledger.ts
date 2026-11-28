import { MeetingInsightModel } from '../models/Insights.js';
import type { SessionDoc } from './types.js';

/*
 * Organisational memory as structured facts: every task (owner, due date, status), decision (status),
 * and open risk across the meetings a user may see. Answers "who owns X", "what was decided about Y",
 * "what is still pending" precisely, where semantic search over text only finds similar wording.
 */

export interface LedgerTask {
  sessionId: string;
  meetingCode: string;
  meetingTitle: string;
  meetingDate: Date | null;
  id: string;
  task: string;
  owner: string | null;
  ownerUserId: string | null;
  dueDate: string | null;
  status: 'open' | 'done';
  overdue: boolean;
}

export interface Ledger {
  tasks: LedgerTask[];
  decisions: Array<{ sessionId: string; meetingCode: string; meetingTitle: string; meetingDate: Date | null; id: string; statement: string; status: string }>;
  risks: Array<{ sessionId: string; meetingCode: string; meetingTitle: string; meetingDate: Date | null; id: string; kind: string; description: string; severity: string }>;
}

/** Built only from sessions the user may see. */
export async function buildLedger(sessionIds: string[], now = new Date(), maxSessions = 60): Promise<Ledger> {
  if (!sessionIds.length) return { tasks: [], decisions: [], risks: [] };
  const today = now.toISOString().slice(0, 10);
  const sessions = (await MeetingInsightModel.find({ sessionId: { $in: sessionIds } })
    .sort({ startedAt: -1 })
    .limit(maxSessions)
    .select({ sessionId: 1, meetingCode: 1, title: 1, startedAt: 1, 'insights.actionItems': 1, 'insights.decisions': 1, 'insights.risks': 1 })
    .lean()) as SessionDoc[];
  const ledger: Ledger = { tasks: [], decisions: [], risks: [] };
  for (const s of sessions) {
    const meta = { sessionId: s.sessionId, meetingCode: s.meetingCode, meetingTitle: s.title ?? 'Untitled meeting', meetingDate: s.startedAt ?? null };
    for (const a of s.insights?.actionItems ?? []) {
      ledger.tasks.push({
        ...meta, id: a.id, task: a.task, owner: a.owner ?? null, ownerUserId: a.ownerUserId ?? null, dueDate: a.dueDate ?? null,
        status: a.status, overdue: a.status === 'open' && !!a.dueDate && a.dueDate < today,
      });
    }
    for (const d of s.insights?.decisions ?? []) ledger.decisions.push({ ...meta, id: d.id, statement: d.statement, status: d.status });
    for (const r of s.insights?.risks ?? []) {
      if (r.status === 'open') ledger.risks.push({ ...meta, id: r.id, kind: r.kind, description: r.description, severity: r.severity ?? 'medium' });
    }
  }
  return ledger;
}

const day = (d: Date | null) => (d ? new Date(d).toISOString().slice(0, 10) : '?');

/** Compact text for the answer model (newest meetings first). */
export function renderLedger(l: Ledger, maxLines = 250): string {
  const lines: string[] = [];
  for (const t of l.tasks) {
    lines.push(`task [${t.status}${t.overdue ? ', OVERDUE' : ''}] "${t.task}" – owner ${t.owner ?? 'none'}${t.dueDate ? `, due ${t.dueDate}` : ''} (${day(t.meetingDate)} "${t.meetingTitle}")`);
  }
  for (const d of l.decisions) lines.push(`decision [${d.status}] ${d.statement} (${day(d.meetingDate)} "${d.meetingTitle}")`);
  for (const r of l.risks) lines.push(`risk [open, ${r.kind}] ${r.description} (${day(r.meetingDate)} "${r.meetingTitle}")`);
  return lines.slice(0, maxLines).join('\n');
}
