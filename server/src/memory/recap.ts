import { z } from 'zod';
import type { SessionDoc, TranscriptRow } from './types.js';
import { dateLabel } from './chunks.js';

export const RecapOutput = z.object({
  headline: z.string().describe('One line, under 12 words, capturing the outcome of the meeting'),
  overview: z.string().describe('A short paragraph (3-5 sentences) on what was discussed and concluded'),
  highlights: z.array(z.string()).describe('Up to 6 key points: decisions made, important information shared'),
  nextSteps: z.array(z.string()).describe('Up to 6 next steps, each with the owner name and deadline if known'),
});
export type RecapOutput = z.infer<typeof RecapOutput>;

export const RECAP_SYSTEM = `You write the recap people read after a team meeting.
Be faithful to the notes and transcript: never invent decisions, owners or dates.
Distinguish clearly between what was agreed and what is still open – an unresolved
disagreement must be presented as unresolved, not as a decision.
Write in the language mostly used in the meeting. Plain text, no markdown.`;

const MAX_TRANSCRIPT_CHARS = 60_000;

export function recapPrompt(session: SessionDoc, lines: TranscriptRow[]): string {
  let transcript = lines.map((l) => `${l.isAgent ? 'AuMeet AI' : l.speakerName}: ${l.text}`).join('\n');
  // Keep the end of long meetings (where conclusions usually are) if we must cut.
  if (transcript.length > MAX_TRANSCRIPT_CHARS) transcript = '…\n' + transcript.slice(-MAX_TRANSCRIPT_CHARS);

  return [
    `Meeting: "${session.title ?? 'Untitled meeting'}" on ${dateLabel(session.startedAt)}`,
    `Participants: ${(session.participants ?? []).map((p) => p.name).filter(Boolean).join(', ') || 'unknown'}`,
    '',
    'STRUCTURED NOTES (from the live note-taker):',
    JSON.stringify(session.insights ?? {}),
    '',
    'TRANSCRIPT:',
    transcript || '(no transcript)',
  ].join('\n');
}
