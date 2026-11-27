import { GoogleGenAI } from '@google/genai';
import type { Db } from 'mongodb';

/*
 * The AI's memory of earlier sessions of the SAME meeting link (e.g. a weekly stand-up).
 * Deliberately not other meetings: the people in this room may not have been in those.
 * Recaps and memory chunks are produced by the server worker (server/src/memory/).
 */

interface SessionRow {
  sessionId: string;
  title?: string;
  startedAt?: Date;
  recap?: { headline?: string; overview?: string; nextSteps?: string[] };
  insights?: {
    summary?: string;
    decisions?: Array<{ statement: string; status: string; confirmationNeeded?: string | null }>;
    actionItems?: Array<{ task: string; owner: string | null; deadline: string | null; status: string }>;
  };
}

const day = (d?: Date) => (d ? new Date(d).toISOString().slice(0, 10) : 'an earlier date');

/** Text block for the assistant's instructions; '' when this is the first session. */
export async function earlierSessionsBrief(db: Db, meetingCode: string, currentSessionId: string, max = 3): Promise<string> {
  const rows = (await db
    .collection('meeting_insights')
    .find({ meetingCode, sessionId: { $ne: currentSessionId } })
    .sort({ startedAt: -1 })
    .limit(max)
    .project({ sessionId: 1, title: 1, startedAt: 1, recap: 1, insights: 1 })
    .toArray()) as unknown as SessionRow[];
  if (rows.length === 0) return '';

  const parts: string[] = [];
  for (const s of rows.reverse()) {
    const lines = [`Session on ${day(s.startedAt)}:`];
    const summary = s.recap?.overview || s.insights?.summary;
    if (summary) lines.push(`  Summary: ${summary}`);
    const agreed = (s.insights?.decisions ?? []).filter((d) => d.status === 'agreed').map((d) => d.statement);
    if (agreed.length) lines.push(`  Agreed: ${agreed.join('; ')}`);
    const open = (s.insights?.decisions ?? []).filter((d) => d.status === 'disputed' || d.confirmationNeeded);
    if (open.length) lines.push(`  Left unresolved: ${open.map((d) => d.statement).join('; ')}`);
    const tasks = (s.insights?.actionItems ?? []).filter((a) => a.status === 'open');
    if (tasks.length) {
      lines.push(`  Open tasks: ${tasks.map((a) => `${a.task} (${a.owner ?? 'no owner'}${a.deadline ? `, ${a.deadline}` : ''})`).join('; ')}`);
    }
    if (lines.length > 1) parts.push(lines.join('\n'));
  }
  if (parts.length === 0) return '';

  return `EARLIER SESSIONS OF THIS SAME MEETING (oldest first). Use this when people refer to "last time",
follow up on open tasks, or revisit unresolved decisions. Say which session something came from.
${parts.join('\n')}`;
}

export interface HistoryHit {
  date: string;
  kind: string;
  text: string;
}

export function historySearcher(db: Db, opts: { apiKey: string; model: string; dims: number; meetingCode: string }) {
  const ai = new GoogleGenAI({ apiKey: opts.apiKey });
  const col = db.collection('memory_chunks');

  return async (query: string, k = 5): Promise<HistoryHit[]> => {
    const res = await ai.models.embedContent({
      model: opts.model,
      contents: [query],
      config: { taskType: 'RETRIEVAL_QUERY', outputDimensionality: opts.dims },
    });
    const raw = res.embeddings?.[0]?.values ?? [];
    const len = Math.sqrt(raw.reduce((s, x) => s + x * x, 0)) || 1;
    const q = raw.map((x) => x / len);

    const chunks = await col
      .find({ meetingCode: opts.meetingCode })
      .sort({ startedAt: -1 })
      .limit(2000)
      .project({ kind: 1, text: 1, startedAt: 1, embedding: 1 })
      .toArray();

    return chunks
      .map((c) => {
        const e = c['embedding'] as number[];
        let s = 0;
        for (let i = 0; i < Math.min(e.length, q.length); i++) s += e[i]! * q[i]!;
        return { date: day(c['startedAt'] as Date), kind: c['kind'] as string, text: c['text'] as string, score: s };
      })
      .filter((h) => h.score >= 0.35)
      .sort((a, b) => b.score - a.score)
      .slice(0, k)
      .map(({ score: _s, ...h }) => h);
  };
}
