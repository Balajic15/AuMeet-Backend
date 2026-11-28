import { z } from 'zod';
import { fence, UNTRUSTED_RULES } from '../ai/untrusted.js';
import type { SessionDoc, TranscriptRow } from './types.js';
import { dateLabel } from './chunks.js';

export const RecapOutput = z.object({
  headline: z.string().describe('One line, under 12 words, capturing the outcome of the meeting'),
  overview: z.string().describe('A short paragraph (3-5 sentences) on what was discussed and concluded'),
  highlights: z.array(z.string()).describe('Up to 6 key points: decisions made, important information shared'),
  nextSteps: z.array(z.string()).describe('Up to 6 next steps, each with the owner name and deadline if known'),
  goalOutcome: z
    .object({
      status: z.enum(['met', 'partly_met', 'not_met', 'no_goal']).describe('Whether the MEETING GOAL was achieved; "no_goal" if none was set'),
      summary: z.string().describe('One or two sentences: what was achieved against the goal and what is still missing, or ""'),
    })
    .optional(),
  unfinished: z
    .array(z.string())
    .describe('Up to 6 things the meeting set out to do but did not finish: unfinished agenda items, unmet parts of the goal, unresolved conflicts')
    .optional(),
});
export type RecapOutput = z.infer<typeof RecapOutput>;

export const RECAP_SYSTEM = `You write the recap people read after a team meeting.
Be faithful to the notes and transcript: never invent decisions, owners or dates.
Distinguish clearly between what was agreed and what is still open – an unresolved
disagreement must be presented as unresolved, not as a decision.
When a MEETING GOAL is given, judge it strictly: "met" only if the meeting clearly achieved it,
"partly_met" if some of it was achieved, otherwise "not_met"; mention agenda items that were not covered,
and list what remains unfinished (unfinished agenda items, unmet parts of the goal, open conflicts and risks).
Write in the language mostly used in the meeting. Plain text, no markdown.

${UNTRUSTED_RULES}`;

const MAX_TRANSCRIPT_CHARS = 60_000;

export interface RecapPrep {
  goal?: string;
  agenda?: Array<{ title: string; minutes?: number | null }>;
}

export function recapPrompt(session: SessionDoc, lines: TranscriptRow[], prep: RecapPrep = {}): string {
  let transcript = lines.map((l) => `${l.isAgent ? 'AuMeet AI' : l.speakerName}: ${l.text}`).join('\n');
  // Keep the end of long meetings (where conclusions usually are) if we must cut.
  if (transcript.length > MAX_TRANSCRIPT_CHARS) transcript = '…\n' + transcript.slice(-MAX_TRANSCRIPT_CHARS);

  return [
    `Meeting: "${session.title ?? 'Untitled meeting'}" on ${dateLabel(session.startedAt)}`,
    `Participants: ${(session.participants ?? []).map((p) => p.name).filter(Boolean).join(', ') || 'unknown'}`,
    prep.goal ? `MEETING GOAL: ${prep.goal}` : 'MEETING GOAL: (none set)',
    prep.agenda?.length
      ? `AGENDA: ${prep.agenda.map((a) => a.title + (a.minutes ? ` (${a.minutes} min)` : '')).join('; ')}`
      : '',
    '',
    fence('STRUCTURED NOTES (from the live note-taker)', JSON.stringify(session.insights ?? {})),
    '',
    fence('TRANSCRIPT', transcript || '(no transcript)'),
  ].join('\n');
}
