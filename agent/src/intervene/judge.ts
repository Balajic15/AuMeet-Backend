import { z } from 'zod';
import type { StructuredCall } from '../gemini.js';
import { renderNotes } from '../intel/render.js';
import type { Insights } from '../intel/schema.js';
import { formatUtterances, type Utterance } from '../transcript.js';
import type { Candidate } from './candidates.js';

export const Verdict = z.object({
  speak: z.boolean().describe('true only if interjecting right now clearly helps the group'),
  message: z.string().describe('What to say out loud (1-2 short sentences), or "" when not speaking'),
  reason: z.string().describe('One short sentence explaining the choice (for logs)'),
});
export type Verdict = z.infer<typeof Verdict>;

export type JudgeFn = (input: {
  candidate: Candidate;
  insights: Insights;
  recent: readonly Utterance[];
  silenceMs: number;
}) => Promise<Verdict>;

const SYSTEM = `You are AuMeet AI, a participant in a live team meeting. You are considering speaking up
WITHOUT being asked. Interrupting a meeting has a real cost, so be conservative.

Speak only if ALL of these hold:
- The issue is real and still unresolved according to the latest lines of the transcript
  (if someone already confirmed, assigned, or summarised it, do NOT speak).
- The group is not in the middle of working it out (someone just asked a question, or is mid-argument).
- Raising it now would genuinely help the team.

If you speak: one or two short, friendly sentences, spoken aloud (no lists, no markdown), addressed to
the group or the right person by name, in the language the meeting is mostly held in. Ask; don't decide
for them. Never pretend something was agreed.`;

const FACILITATION = new Set(['open_meeting', 'agenda_next', 'wrap_up']);

export function judgePrompt(input: Parameters<JudgeFn>[0]): string {
  const notes = renderNotes(input.insights);
  return [
    `What you are considering: ${input.candidate.goal}`,
    `A possible phrasing: "${input.candidate.suggestion}"`,
    FACILITATION.has(input.candidate.kind)
      ? 'This is a facilitation step the host switched on (facilitator mode). It is not an issue to be resolved: ' +
        'speak unless people are clearly in the middle of a conversation or have just done it themselves.'
      : '',
    `Nobody has spoken for ${(input.silenceMs / 1000).toFixed(1)} seconds.`,
    '',
    'CURRENT NOTES:',
    notes || '(none)',
    '',
    'MOST RECENT TRANSCRIPT:',
    formatUtterances(input.recent, 'UTC') || '(empty)',
  ].join('\n');
}

export function geminiJudge(call: StructuredCall): JudgeFn {
  return (input) => call(Verdict, { system: SYSTEM, prompt: judgePrompt(input), temperature: 0.3 });
}
