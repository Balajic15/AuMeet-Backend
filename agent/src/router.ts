import { z } from 'zod';
import type { Behaviour } from './behaviour.js';
import type { StructuredCall } from './gemini.js';
import { formatUtterances, type Utterance } from './transcript.js';

/*
 * Is this line meant for the AI? Judged by the model from context, in any language: follow-ups to
 * its last answer, its name misheard by speech-to-text, and (when the host allows it) questions to the
 * room. Lines that contain the configured name skip this and are answered straight away.
 */

export const RouteDecision = z.object({
  respond: z.boolean().describe('true if the AI should answer this line now'),
  kind: z.enum(['direct', 'follow_up', 'room_question', 'none']),
  reason: z.string().describe('One short sentence'),
});
export type RouteDecision = z.infer<typeof RouteDecision>;

export interface RouteInput {
  line: Utterance;
  recent: readonly Utterance[];
  behaviour: Behaviour;
  /** Host allows answering questions asked to the whole room. */
  answerRoomQuestions: boolean;
  /** The AI's last spoken answer: to whom, what, how long ago. */
  lastAnswer: { to: string; text: string; secondsAgo: number } | null;
  participants: string[];
}

const SYSTEM = `You route lines of a live meeting transcript. Decide whether the AI participant should answer
the LATEST line now.
- "direct": the line speaks to the AI (its name may be misheard, e.g. similar-sounding words), or asks it to do
  something.
- "follow_up": the person the AI just answered speaks again shortly after, with a question or request that
  continues that exchange ("and who owns that?", "what about the deadline?") – even without saying the name.
  Follow-ups are always allowed; the ROOM QUESTIONS setting does not apply to them. Thanks, "okay" or remarks
  clearly aimed at colleagues are not follow-ups.
- "room_question": a genuine question to the whole group that the AI could usefully answer from the meeting,
  its notes or documents – only counts when ROOM QUESTIONS are allowed. Questions to a named colleague,
  rhetorical questions and small talk never count.
- "none": everything else. When in doubt, "none" – people talk to each other far more than to the AI.`;

export function routePrompt(i: RouteInput): string {
  return [
    `AI name: ${i.behaviour.name}${i.behaviour.wakeWords.length ? ` (also heard as: ${i.behaviour.wakeWords.join(', ')})` : ''}`,
    `Participants: ${i.participants.join(', ') || 'unknown'}`,
    `ROOM QUESTIONS: ${i.answerRoomQuestions ? 'allowed' : 'not allowed'}`,
    i.lastAnswer
      ? `The AI last answered ${i.lastAnswer.to} ${i.lastAnswer.secondsAgo}s ago: "${i.lastAnswer.text.slice(0, 300)}"`
      : 'The AI has not answered anyone yet.',
    '',
    'RECENT TRANSCRIPT:',
    formatUtterances(i.recent, 'UTC') || '(empty)',
    '',
    `LATEST LINE: ${i.line.speakerName}: ${i.line.text}`,
    i.lastAnswer && i.lastAnswer.to === i.line.speakerName
      ? `(${i.line.speakerName} is the person the AI answered ${i.lastAnswer.secondsAgo}s ago.)`
      : '',
  ].join('\n');
}

export type RouteFn = (input: RouteInput) => Promise<RouteDecision>;

export function geminiRouter(call: StructuredCall): RouteFn {
  return async (input) => {
    const d = await call(RouteDecision, { system: SYSTEM, prompt: routePrompt(input), temperature: 0 });
    // A room question only counts when the host allows it.
    if (d.kind === 'room_question' && !input.answerRoomQuestions) return { ...d, respond: false };
    return { ...d, respond: d.respond && d.kind !== 'none' };
  };
}
