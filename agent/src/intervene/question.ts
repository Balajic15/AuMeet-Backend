import { z } from 'zod';
import type { StructuredCall } from '../gemini.js';
import { renderNotes } from '../intel/render.js';
import type { Insights } from '../intel/schema.js';
import { formatUtterances, type Utterance } from '../transcript.js';

/**
 * "Answer questions in the room" mode: the AI may answer a question nobody addressed to it –
 * but not questions people ask each other ("Ravi, can you send that?").
 */

const QUESTION_START =
  /^(what|why|how|when|where|who|whom|whose|which|can|could|would|will|should|shall|is|are|was|were|do|does|did|has|have|any ?one|anybody|any idea)\b/i;

export function looksLikeQuestion(text: string): boolean {
  const t = text.trim();
  if (t.split(/\s+/).length < 3) return false;
  return /\?\s*$/.test(t) || QUESTION_START.test(t);
}

/** "Ravi, can you…" / "…what do you think, Ravi?" – aimed at a person in the room. */
export function addressedToPerson(text: string, names: string[]): boolean {
  const t = text.trim().toLowerCase();
  return names
    .map((n) => n.trim().toLowerCase().split(/\s+/)[0]!)
    .filter((n) => n.length >= 2)
    .some((first) => t.startsWith(first + ',') || t.startsWith(first + ' ') || new RegExp(`,\\s*${first}\\??\\s*$`).test(t));
}

export const QuestionVerdict = z.object({
  answer: z.boolean().describe('true only if the AI should answer this question out loud now'),
  reason: z.string().describe('one short sentence, for logs'),
});
export type QuestionVerdict = z.infer<typeof QuestionVerdict>;

const SYSTEM = `You are AuMeet AI, a participant in a live meeting, deciding whether to answer a question
that was NOT addressed to you by name. Answer it only if:
- it is asked to the room in general (not to a specific person, and not rhetorical), AND
- you can genuinely help: it's about what was said or decided in this meeting, the meeting's goal or
  agenda, the shared documents, or a quick factual matter.
Do NOT answer when the question is clearly for a colleague, asks for a personal opinion or commitment
("can you take this?"), or the group is mid-discussion and someone is about to reply.`;

export async function shouldAnswerQuestion(
  call: StructuredCall,
  input: { question: string; speaker: string; recent: readonly Utterance[]; insights: Insights; prepSummary: string },
): Promise<QuestionVerdict> {
  const prompt = [
    `QUESTION from ${input.speaker}: "${input.question}"`,
    '',
    input.prepSummary ? `MEETING PREPARATION:\n${input.prepSummary}\n` : '',
    'CURRENT NOTES:',
    renderNotes(input.insights) || '(none)',
    '',
    'RECENT TRANSCRIPT:',
    formatUtterances(input.recent, 'UTC') || '(empty)',
  ].join('\n');
  return call(QuestionVerdict, { system: SYSTEM, prompt, temperature: 0.1 });
}
