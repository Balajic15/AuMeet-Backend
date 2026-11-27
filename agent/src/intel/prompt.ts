import { formatUtterances, type Utterance } from '../transcript.js';
import type { Insights } from './schema.js';

export const ANALYST_SYSTEM = `You are the note-taker for a live team meeting. You maintain structured meeting notes
from a transcript where every line is "#<line> [time] Speaker: text". You receive the current notes
and the latest transcript, and return the COMPLETE updated notes.

Rules:
- Return every existing item again (unchanged if nothing new), keeping its id. Use id "" only for new items.
  Never drop an item: mark it closed/rejected/done/answered instead.
- Cite transcript line numbers as evidence for each decision, task and question.
- Use participant names exactly as written in the transcript. Never invent people, tasks or dates.
- Lines from "AuMeet AI" are the assistant – it never makes decisions or takes tasks for the team.

Decisions – be strict, this matters most:
- "proposed": someone suggested it, nobody objected, nobody explicitly confirmed.
- "disputed": people supported different options and the disagreement was not explicitly resolved.
- "agreed": the group explicitly settled on ONE specific option (e.g. "agreed, PostgreSQL it is",
  "let's go with Bob's suggestion", or everyone who spoke supported the same option).
- "rejected": the group explicitly dropped it.
- Vague acknowledgements like "okay", "sounds good", "let's proceed", "fine, moving on" do NOT confirm
  anything when several options are on the table. Keep the decision "disputed" and set
  confirmationNeeded to a short question for the group.
  Example:
    #1 A: Let's use MongoDB.
    #2 B: I think PostgreSQL is better for our requirements.
    #3 C: Okay, let's proceed.
  → statement "Which database to use", status "disputed", options ["MongoDB", "PostgreSQL"],
    proposedBy ["A"], supporters [], objectors [], confirmationNeeded
    "Can we confirm which database the team has agreed to use?"
- Merge restatements of the same decision into one item instead of duplicating it.

Action items: concrete work someone committed to or was assigned ("I'll draft the spec", "Ravi, can you
check pricing?" → owner Ravi once he accepts or doesn't object). Keep the deadline as said and resolve
dueDate (YYYY-MM-DD) against the meeting date when it is unambiguous. Mark done only if said so.

Open questions: questions raised that are still unanswered; mark answered when resolved.

Topics: the main subjects discussed, short titles; "closed" once the group moved on.

Write notes in the language mostly used in the meeting. Be concise.`;

/** The user turn: meeting facts, current notes, and the recent transcript. */
export function analystPrompt(opts: {
  title: string;
  meetingDate: Date;
  participants: string[];
  current: Insights;
  lines: Utterance[];
  final: boolean;
}): string {
  const { current } = opts;
  const notes = {
    summary: current.summary,
    topics: current.topics.map(({ id, title, status }) => ({ id, title, status })),
    decisions: current.decisions.map((d) => ({
      id: d.id,
      topic: d.topic,
      statement: d.statement,
      status: d.status,
      options: d.options,
      proposedBy: d.proposedBy,
      supporters: d.supporters,
      objectors: d.objectors,
      confirmationNeeded: d.confirmationNeeded ?? '',
      evidence: d.evidence,
    })),
    actionItems: current.actionItems.map((a) => ({
      id: a.id,
      task: a.task,
      owner: a.owner ?? '',
      deadline: a.deadline ?? '',
      dueDate: a.dueDate ?? '',
      status: a.status,
      evidence: a.evidence,
    })),
    openQuestions: current.openQuestions.map((q) => ({
      id: q.id,
      question: q.question,
      askedBy: q.askedBy ?? '',
      status: q.status,
      evidence: q.evidence,
    })),
  };

  const transcript = opts.lines
    .map((u) => `#${u.id} ${formatUtterances([u], 'UTC')}`)
    .join('\n');

  return [
    `Meeting: "${opts.title}"`,
    `Meeting date: ${opts.meetingDate.toISOString().slice(0, 10)} (${opts.meetingDate.toLocaleDateString('en-US', { weekday: 'long', timeZone: 'UTC' })})`,
    `Participants so far: ${opts.participants.join(', ') || 'unknown'}`,
    opts.final ? 'The meeting has ENDED. Produce the final notes and a complete summary.' : '',
    `Lines up to #${current.analyzedThrough} were already analysed into the current notes; later lines are new.`,
    '',
    'CURRENT NOTES (JSON):',
    JSON.stringify(notes),
    '',
    'TRANSCRIPT (most recent part, times in UTC):',
    transcript || '(empty)',
  ]
    .filter((l) => l !== '')
    .join('\n');
}
