import type { StructuredCall } from '../gemini.js';
import { formatUtterances, type Utterance } from '../transcript.js';
import { fence, UNTRUSTED_RULES } from '../untrusted.js';
import { renderNotes } from './render.js';
import { CopilotOutput, type EarlierItemRef, type Insights, type PastDecisionRef } from './schema.js';

/*
 * The live copilot: a separate, focused model call after each notes update. It sees the fresh notes, the recent
 * transcript, the goal and agenda with time used, the team's earlier decisions and open work, what people
 * dismissed, and how this team reacted to suggestions before. It returns ranked suggestions with an honest
 * relevance; the app shows only those above the host's threshold (normalize.ts mergeCopilot).
 */

export type CopilotFn = (system: string, prompt: string) => Promise<CopilotOutput>;

export function geminiCopilot(call: StructuredCall): CopilotFn {
  return (system, prompt) => call(CopilotOutput, { system, prompt, temperature: 0.3 });
}

export const COPILOT_SYSTEM = `You are the quiet copilot of a live team meeting: suggestions appear on participants' screens and are
never spoken. Think like an experienced colleague who knows this team's history, the meeting's goal and the people
present, and who only speaks up when it matters.

Return:
- currentFocus: what is being discussed right now, in a few words.
- offTopic: true when the latest stretch has wandered from the goal, agenda or evident purpose (+ offTopicNote).
- repeating: true when people keep re-arguing the same point without new information (+ repetitionNote).
- suggestions, each with a stable key (reuse it for the same idea later), a kind, the text, a one-line why and an
  honest relevance 0–1:
  - "question": a question someone could ask now to move forward or settle something.
  - "missing_consideration": an important technical or business aspect nobody raised for what is being decided.
    Look hard at decisions and plans just made: a risky change (production systems, data migrations, launches,
    payments, security, customers, contracts) without a rollback/backup plan, testing, an owner, a deadline, a
    budget or a communication plan deserves one (relevance 0.8+). Domain knowledge is welcome if it fits.
  - "next_topic": this point is done or stuck – suggest moving on, and to what.
  - "agenda": with an agenda, a concrete time adjustment (shorten, park, merge, reorder) given time used and left.
  - "from_history": the talk touches an EARLIER AGREED DECISION or EARLIER OPEN ITEM – remind and ask (relevance
    0.8+ when it conflicts with or depends on it; cite P/E ids in relatedItems).
  - "unanswered": an open question asked a while ago and dropped while the talk moved on.
- discussNext / agendaAdvice: one line each for the most important next-topic / agenda point, or "".

Relevance must be honest: the app hides everything below the team's threshold, so propose what could genuinely
help (up to 5) and score it rather than holding back. Score low (or leave out) what is minor, already handled, just
said, or being worked out right now. With nothing useful, return no suggestions. Never repeat anything listed as
DISMISSED. Lean towards the kinds this team found useful before and away from those it dismissed.
Write in the language mostly used in the meeting. Short and concrete.

${UNTRUSTED_RULES}`;

export function copilotPrompt(o: {
  title: string;
  insights: Insights;
  lines: readonly Utterance[];
  present: string[];
  elapsedMinutes: number;
  goal?: string;
  agenda?: Array<{ id: string; title: string; minutes: number | null }>;
  pastDecisions?: PastDecisionRef[];
  earlierItems?: EarlierItemRef[];
  dismissed?: string[];
  feedback?: string;
  now?: number;
}): string {
  const now = o.now ?? Date.now();
  const planned = (o.agenda ?? []).reduce((t, a) => t + (a.minutes ?? 0), 0);
  const agenda = o.insights.agenda.map((a) => {
    const used = a.startedAt ? Math.max(0, Math.round(((a.doneAt ? Date.parse(a.doneAt) : now) - Date.parse(a.startedAt)) / 60_000)) : 0;
    return `- ${a.title}: ${a.status.replace('_', ' ')}${a.minutes ? `, planned ${a.minutes} min` : ''}${a.startedAt ? `, ${used} min used` : ''}`;
  });
  const openQs = o.insights.openQuestions
    .filter((q) => q.status === 'open')
    .map((q) => `- ${q.id}: ${q.question} (open ${Math.max(0, Math.round((now - Date.parse(q.firstSeenAt ?? new Date(now).toISOString())) / 60_000))} min)`);
  return [
    `Meeting "${o.title}". ${o.elapsedMinutes} min in${planned ? ` of ${planned} planned (${Math.max(0, planned - o.elapsedMinutes)} min left)` : ''}.`,
    `People present: ${o.present.join(', ') || 'unknown'}`,
    o.goal ? `MEETING GOAL: ${o.goal}` : '',
    agenda.length ? `AGENDA PROGRESS:\n${agenda.join('\n')}` : '',
    o.pastDecisions?.length
      ? fence('EARLIER AGREED DECISIONS', o.pastDecisions.map((p) => `${p.ref} [${p.date}, "${p.title}"]: ${p.statement}`).join('\n'))
      : '',
    o.earlierItems?.length
      ? fence(
          'EARLIER OPEN ITEMS',
          o.earlierItems.map((e) => `${e.ref} [${e.date}, "${e.title}"] ${e.kind}: ${e.text}${e.owner ? ` – ${e.owner}` : ''}${e.dueDate ? `, due ${e.dueDate}` : ''}`).join('\n'),
        )
      : '',
    o.dismissed?.length ? `DISMISSED (never suggest again):\n${o.dismissed.map((d) => `- ${d}`).join('\n')}` : '',
    o.feedback ? `THIS TEAM'S REACTIONS TO EARLIER SUGGESTIONS:\n${o.feedback}` : '',
    openQs.length ? `OPEN QUESTIONS:\n${openQs.join('\n')}` : '',
    o.insights.copilot?.suggestions?.length
      ? `CURRENTLY SHOWN SUGGESTIONS (keep their keys if still relevant):\n${o.insights.copilot.suggestions.map((x) => `- ${x.key} (${x.kind}): ${x.text}`).join('\n')}`
      : '',
    '',
    fence('CURRENT NOTES', renderNotes({ ...o.insights, copilot: null }) || '(none yet)'),
    '',
    fence('RECENT TRANSCRIPT (UTC)', formatUtterances(o.lines.slice(-40), 'UTC') || '(empty)'),
  ]
    .filter((l) => l !== '')
    .join('\n');
}
