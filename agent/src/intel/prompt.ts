import { AGENT_DISPLAY_NAME } from '../config.js';
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
- Lines from "${AGENT_DISPLAY_NAME}" are the assistant – it never makes decisions or takes tasks for the team.

Decisions – be strict, this matters most:
- "proposed": someone suggested it, nobody objected, nobody explicitly confirmed.
- "disputed": people supported DIFFERENT options (or someone explicitly objected) and it was not resolved.
  Asking for time or information ("let me check the test results first", "can we look at the numbers?")
  is NOT an objection – the item stays "proposed". Don't list such people as objectors.
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
check pricing?" → owner Ravi once he accepts or doesn't object). ALSO record work the group says must be
done even if nobody took it yet ("somebody needs to update the docs") with owner "" – it must not be lost. Keep the deadline as said and resolve
dueDate (YYYY-MM-DD) against the meeting date when it is unambiguous. Mark done only if said so.

Contradictions: if EARLIER AGREED DECISIONS are listed, set "contradicts" on a decision to the P-id
of an earlier decision it reverses, replaces or conflicts with (e.g. earlier "Use PostgreSQL for billing",
now "Move billing to MongoDB"). Revisiting or confirming the same choice is NOT a contradiction. Otherwise "".

Confirmed vs suggested vs assumed – keep these apart:
- A decision is "agreed" only when explicitly settled; a suggestion nobody settled stays "proposed".
- assumptions: things people treat as true without anyone checking ("assuming the API is ready",
  "the client will surely accept"). "confirmed" once someone verifies it, "invalidated" if shown wrong.
  Never record an assumption as a decision.

keyPoints: important information, insights, numbers or concerns that are not decisions, tasks or
questions ("churn rose 4% last month", "legal must review every contract"). "high" when it changes plans.

Risks (risks): spot problems while there is still time to fix them:
- "conflict": statements that cannot both hold (one person commits to Friday while another says a
  required dependency only arrives Monday).
- "dependency": a task that needs something from someone else that is not yet secured.
- "deadline": a date that looks unrealistic given what was said (scope, capacity, other dates).
- "blocker": something stopping progress; set earlierRef when it repeats an EARLIER OPEN ITEM.
- "contradiction": a statement or decision that contradicts an earlier one in this meeting.
Give a short suggestedQuestion that would clear it up, link relatedItems, and mark it "resolved"
once clarified. Don't invent risks – each must be grounded in specific lines.

Copilot (copilot) – live guidance shown quietly on screen, never spoken:
- currentFocus: what is being discussed right now.
- offTopic: true when the latest stretch has wandered from the goal, agenda or evident purpose.
- missingInfo: what the group still needs to know to settle the current items (owners, dates,
  numbers, acceptance criteria …). Only genuinely missing things.
- suggestedQuestions: up to 3 questions someone could ask now to move forward.
- discussNext: given goal, agenda, open items and time, what should come next and why.
- agendaAdvice: with an agenda, compare time used with time left and recommend a concrete
  adjustment (shorten, park, merge or reorder items); "" when on plan.

Open questions: questions raised that are still unanswered; mark answered when resolved.

Topics: the main subjects discussed, short titles; "closed" once the group moved on.

Progress (only when a MEETING GOAL or AGENDA is given):
- goalStatus: "on_track" while the discussion serves the goal; "drifting" when it wanders onto
  unrelated topics for a while; "off_track" when a long stretch has nothing to do with the goal;
  "achieved" only when the goal is clearly met (e.g. the decision it asks for was explicitly agreed).
- For every agenda item (use its id exactly): "in_progress" while it is being discussed or once it was
  started but left unfinished; "done" ONLY when the group reached its outcome (decided, answered or
  explicitly closed it); "skipped" if explicitly postponed. Dropping a topic for small talk is NOT done.

LESSONS FROM CORRECTIONS, when given, are mistakes this team has corrected in your earlier notes.
Follow them – they override your defaults.

Write notes in the language mostly used in the meeting. Be concise.`;

/** The user turn: meeting facts, current notes, and the recent transcript. */
export function analystPrompt(opts: {
  title: string;
  meetingDate: Date;
  participants: string[];
  current: Insights;
  lines: Utterance[];
  final: boolean;
  goal?: string;
  agenda?: Array<{ id: string; title: string; minutes: number | null }>;
  /** Minutes since the meeting started. */
  elapsedMinutes?: number;
  pastDecisions?: Array<{ ref: string; statement: string; date: string; title: string }>;
  earlierItems?: Array<{ ref: string; kind: string; text: string; owner: string | null; dueDate: string | null; date: string; title: string }>;
  /** Learned from this team's corrections of earlier notes. */
  lessons?: string[];
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
      contradicts: d.contradicts?.ref ?? '',
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
    keyPoints: (current.keyPoints ?? []).map(({ id, point, importance, evidence }) => ({ id, point, importance, evidence })),
    assumptions: (current.assumptions ?? []).map((a) => ({ id: a.id, statement: a.statement, madeBy: a.madeBy ?? '', status: a.status, evidence: a.evidence })),
    risks: (current.risks ?? []).map((r) => ({
      id: r.id,
      kind: r.kind,
      description: r.description,
      involves: r.involves,
      relatedItems: r.relatedItems,
      earlierRef: r.earlier?.ref ?? '',
      severity: r.severity,
      suggestedQuestion: r.suggestedQuestion ?? '',
      status: r.status,
      evidence: r.evidence,
    })),
  };
  const planned = (opts.agenda ?? []).reduce((t, a) => t + (a.minutes ?? 0), 0);

  const transcript = opts.lines
    .map((u) => `#${u.id} ${formatUtterances([u], 'UTC')}`)
    .join('\n');

  return [
    `Meeting: "${opts.title}"`,
    `Meeting date: ${opts.meetingDate.toISOString().slice(0, 10)} (${opts.meetingDate.toLocaleDateString('en-US', { weekday: 'long', timeZone: 'UTC' })})`,
    `Participants so far: ${opts.participants.join(', ') || 'unknown'}`,
    opts.goal ? `MEETING GOAL: ${opts.goal}` : '',
    opts.agenda?.length
      ? 'AGENDA (id: title [planned minutes] – current status):\n' +
        opts.agenda
          .map((a) => {
            const cur = current.agenda.find((x) => x.id === a.id);
            return `${a.id}: ${a.title}${a.minutes ? ` [${a.minutes} min]` : ''} – ${cur?.status ?? 'not_started'}`;
          })
          .join('\n')
      : '',
    opts.pastDecisions?.length
      ? 'EARLIER AGREED DECISIONS (from previous meetings; cite as "contradicts"):\n' +
        opts.pastDecisions.map((p) => `${p.ref} [${p.date}, "${p.title}"]: ${p.statement}`).join('\n')
      : '',
    opts.earlierItems?.length
      ? 'EARLIER OPEN ITEMS (from previous meetings; cite as "earlierRef" when a risk repeats or depends on one):\n' +
        opts.earlierItems
          .map((e) => `${e.ref} [${e.date}, "${e.title}"] ${e.kind}: ${e.text}${e.owner ? ` – ${e.owner}` : ''}${e.dueDate ? `, due ${e.dueDate}` : ''}`)
          .join('\n')
      : '',
    opts.lessons?.length ? 'LESSONS FROM CORRECTIONS:\n' + opts.lessons.map((l) => `- ${l}`).join('\n') : '',
    opts.elapsedMinutes !== undefined
      ? `Minutes since the meeting started: ${opts.elapsedMinutes}${planned ? ` (planned total ${planned} min, ${Math.max(0, planned - opts.elapsedMinutes)} min left)` : ''}`
      : '',
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
