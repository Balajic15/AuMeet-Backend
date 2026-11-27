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
  /** Facilitator mode: open the meeting, announce agenda transitions, wrap up. */
  facilitator: boolean;
  /** Meeting code this one follows up on (host's choice) – its open items carry over. */
  followUpOf: string | null;
}

export function emptyPrep(): MeetingPrep {
  return { goal: '', agenda: [], documents: [], replyMode: 'named', facilitator: false, followUpOf: null };
}

const PREVIEW_CHARS = 1200;

/** Goal, agenda, reply mode and document previews for a meeting. */
export async function loadPrep(db: Db, meetingCode: string): Promise<MeetingPrep> {
  const [meeting, docs] = await Promise.all([
    db.collection('meetings').findOne(
      { code: meetingCode },
      { projection: { prep: 1, 'settings.aiReplyMode': 1, 'settings.aiFacilitator': 1 } },
    ),
    db
      .collection('meeting_documents')
      .find({ meetingCode }, { projection: { filename: 1, text: 1 } })
      .sort({ createdAt: 1 })
      .limit(20)
      .toArray(),
  ]);
  const prep = (meeting?.['prep'] ?? {}) as {
    goal?: string;
    agenda?: Array<{ id: string; title: string; minutes?: number }>;
    followUpOf?: string;
  };
  const settings = (meeting?.['settings'] ?? {}) as { aiReplyMode?: string; aiFacilitator?: boolean };
  const mode = settings.aiReplyMode;
  return {
    goal: (prep.goal ?? '').trim(),
    agenda: (prep.agenda ?? []).map((a) => ({ id: a.id, title: a.title, minutes: a.minutes ?? null })),
    documents: docs.map((d) => ({
      id: String(d['_id']),
      filename: d['filename'] as string,
      preview: ((d['text'] as string) ?? '').slice(0, PREVIEW_CHARS),
    })),
    replyMode: mode === 'any' ? 'any' : 'named',
    facilitator: settings.aiFacilitator === true,
    followUpOf: prep.followUpOf && prep.followUpOf !== meetingCode ? prep.followUpOf : null,
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
  if (p.facilitator) {
    parts.push(
      'You are also the FACILITATOR of this meeting (the host switched this on): you open the meeting, move the group ' +
        'through the agenda and keep time. If someone asks you to wrap up, give a spoken recap of about thirty seconds: ' +
        'what was agreed, what is still undecided, each task with its owner and due date, and what remains open.',
    );
  }
  if (p.goal || p.agenda.length) {
    parts.push(
      'Help the meeting reach its goal: when asked, say what is covered and what remains; never decide for the group.',
    );
  }
  return parts.join('\n\n');
}
