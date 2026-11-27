import type { Db } from 'mongodb';

/** What the host prepared for the meeting (server/src/models/Meeting.ts + MeetingDocument.ts). */
export interface AgendaPlan {
  id: string;
  title: string;
  minutes: number | null;
}

export interface MeetingPrep {
  goal: string;
  agenda: AgendaPlan[];
  documents: Array<{ id: string; filename: string; preview: string }>;
  replyMode: 'named' | 'any';
}

export function emptyPrep(): MeetingPrep {
  return { goal: '', agenda: [], documents: [], replyMode: 'named' };
}

const PREVIEW_CHARS = 1200;

/** Goal, agenda, reply mode and document previews for a meeting. */
export async function loadPrep(db: Db, meetingCode: string): Promise<MeetingPrep> {
  const [meeting, docs] = await Promise.all([
    db.collection('meetings').findOne(
      { code: meetingCode },
      { projection: { prep: 1, 'settings.aiReplyMode': 1 } },
    ),
    db
      .collection('meeting_documents')
      .find({ meetingCode }, { projection: { filename: 1, text: 1 } })
      .sort({ createdAt: 1 })
      .limit(20)
      .toArray(),
  ]);
  const prep = (meeting?.['prep'] ?? {}) as { goal?: string; agenda?: Array<{ id: string; title: string; minutes?: number }> };
  const mode = (meeting?.['settings'] as { aiReplyMode?: string } | undefined)?.aiReplyMode;
  return {
    goal: (prep.goal ?? '').trim(),
    agenda: (prep.agenda ?? []).map((a) => ({ id: a.id, title: a.title, minutes: a.minutes ?? null })),
    documents: docs.map((d) => ({
      id: String(d['_id']),
      filename: d['filename'] as string,
      preview: ((d['text'] as string) ?? '').slice(0, PREVIEW_CHARS),
    })),
    replyMode: mode === 'any' ? 'any' : 'named',
  };
}

/** Instructions block so the voice assistant knows the goal, agenda and material. */
export function renderPrep(p: MeetingPrep): string {
  const parts: string[] = [];
  if (p.goal) parts.push(`MEETING GOAL: ${p.goal}`);
  if (p.agenda.length) {
    parts.push(
      'AGENDA:\n' + p.agenda.map((a, i) => `${i + 1}. ${a.title}${a.minutes ? ` (${a.minutes} min)` : ''}`).join('\n'),
    );
  }
  if (p.documents.length) {
    parts.push(
      'DOCUMENTS SHARED FOR THIS MEETING (excerpts – use the search_meeting_documents tool for details, and say which document an answer comes from):\n' +
        p.documents.map((d) => `--- ${d.filename} ---\n${d.preview}${d.preview.length >= PREVIEW_CHARS ? ' …' : ''}`).join('\n'),
    );
  }
  if (p.goal || p.agenda.length) {
    parts.push(
      'Help the meeting reach its goal: when asked, say what is covered and what remains; never decide for the group.',
    );
  }
  return parts.join('\n\n');
}
