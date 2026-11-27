import { z } from 'zod';
import { describeBehaviour, type Behaviour } from './behaviour.js';
import { renderCarryover } from './carryover.js';
import type { StructuredCall } from './gemini.js';
import { renderNotes } from './intel/render.js';
import type { Insights } from './intel/schema.js';
import { renderLearning, type IntentStats } from './learning.js';
import { formatUtterances, type Utterance } from './transcript.js';

/*
 * The real-time meeting brain: at every natural pause (and when it asked to be woken) the model
 * looks at the live meeting and decides whether to speak, what to say, to whom, how, and when to
 * look again. No fixed rules, phrases or priorities – those come from the situation and the
 * behaviour settings. Code only enforces the host's limits and never talks over people.
 */

export const BrainDecision = z.object({
  speak: z.boolean().describe('true only if saying something right now clearly helps the group'),
  intent: z
    .string()
    .describe('Short snake_case label of what you want to achieve (your own words), e.g. "confirm_decision", "greet". "" when silent'),
  topicKey: z
    .string()
    .describe('Short stable key for the specific issue, e.g. "decision:database", so it is not raised twice. "" when silent'),
  addressee: z.string().describe('Name of the person you address, "everyone", or ""'),
  message: z.string().describe('Exactly what to say aloud, or "" when silent'),
  reason: z.string().describe('One short sentence: why speak now / why stay silent'),
  recheckInSeconds: z
    .number()
    .int()
    .describe('When to look at the meeting again if nothing new is said (e.g. a time box ends, or give people a minute)'),
  reactions: z
    .array(
      z.object({
        id: z.string().describe('Id of one of YOUR RECENT REMARKS'),
        reaction: z.enum(['engaged', 'ignored', 'rejected', 'pending']),
      }),
    )
    .describe('How people responded to each of your recent remarks still marked pending'),
});
export type BrainDecision = z.infer<typeof BrainDecision>;

export interface Remark {
  id: string;
  at: number;
  intent: string;
  topicKey: string;
  message: string;
  reaction: 'engaged' | 'ignored' | 'rejected' | 'pending';
}

export type BrainEvent = 'start' | 'pause' | 'timer';

export interface BrainInput {
  event: BrainEvent;
  now: number;
  joinedAt: number;
  behaviour: Behaviour;
  title: string;
  facilitator: boolean;
  /** People in the room right now. */
  present: string[];
  insights: Insights;
  transcript: readonly Utterance[];
  silenceMs: number;
  remarks: readonly Remark[];
  learning: IntentStats[];
  /** Host's preparation, rendered (goal, agenda, documents). */
  prep: string;
  /** Things the host's limits currently forbid – the model may still plan for later. */
  blocked: string[];
}

export const BRAIN_SYSTEM = `You are the live judgement of an AI participant in a team video meeting. You are called at
natural pauses and decide whether to say something WITHOUT being asked, and if so exactly what.

Principles:
- Silence is the default. Speaking up interrupts real people; do it only when it clearly helps the group
  reach its goal or keeps important things from being lost (an unconfirmed decision, work without an owner,
  a debate going in circles, the meeting drifting from its goal or running out of time, an open item from
  the previous meeting, a decision that reverses an earlier one, …). Use your judgement – nothing is mandatory.
- Respect the BEHAVIOUR SETTINGS: talkativeness scales how readily you speak; only raise the kinds of things
  you are allowed to; follow the tone, length and the host's instructions.
- Timing: never while people are in the middle of working something out, right after someone asked a
  colleague a question, or when the issue was just handled. Read the latest lines carefully.
- Don't repeat yourself: check YOUR RECENT REMARKS and their topic keys. If people ignored or pushed back on
  something, let it go unless it has become important.
- Ask, don't decide for the group. Never claim something was agreed when it wasn't.
- Speak like a colleague: natural spoken sentences (no lists or markdown), in the language the meeting is
  mostly held in, addressing a person by name when it's for them.
- event "start": you just joined. People need to know you are here and how to call you, so a short hello
  (who you are, how to address you) is usually right – the silence of people waiting to begin is a fine moment.
  Skip it only if the conversation is already in full flow. Base it on who is here and what the meeting is for. If you are the facilitator, open the meeting (goal, agenda, time,
  anything left from last time) and invite the group to begin.
- As facilitator (only when FACILITATOR is on) you may also move the group between agenda items and give a
  short wrap-up of decisions, owners and open items when time is nearly up.
- recheckInSeconds: when it would make sense to look again even if nobody says anything.
- reactions: for each of your recent remarks still pending, judge from the transcript after it whether people
  engaged with it, ignored it, or rejected it ("not now", "we know", annoyed); "pending" if too early to tell.`;

const mins = (ms: number) => Math.max(0, Math.round(ms / 60_000));
const ago = (now: number, t: number) => `${Math.max(0, Math.round((now - t) / 1000))}s ago`;

export function brainPrompt(i: BrainInput): string {
  const firstHuman = i.transcript.find((u) => !u.isAgent);
  const planned = i.insights.agenda.reduce((s, a) => s + (a.minutes ?? 0), 0);
  const agenda = i.insights.agenda.map((a) => {
    const used = a.startedAt ? mins((a.doneAt ? Date.parse(a.doneAt) : i.now) - Date.parse(a.startedAt)) : 0;
    return `- ${a.title}: ${a.status.replace('_', ' ')}${a.minutes ? `, planned ${a.minutes} min` : ''}${a.startedAt ? `, ${used} min so far` : ''}`;
  });
  const goal = i.insights.goal
    ? `Goal status: ${i.insights.goal.status.replace('_', ' ')} for ${mins(i.now - Date.parse(i.insights.goal.since))} min${i.insights.goal.reason ? ` – ${i.insights.goal.reason}` : ''}`
    : '';

  return [
    `EVENT: ${i.event}`,
    `Meeting "${i.title}". You joined ${mins(i.now - i.joinedAt)} min ago. ` +
      (firstHuman ? `Conversation started ${mins(i.now - firstHuman.at)} min ago.` : 'Nobody has spoken yet.') +
      (planned ? ` Planned agenda time: ${planned} min.` : ''),
    `People present: ${i.present.join(', ') || 'nobody'}. Silence right now: ${(i.silenceMs / 1000).toFixed(1)} s.`,
    `FACILITATOR: ${i.facilitator ? 'on' : 'off'}`,
    '',
    'BEHAVIOUR SETTINGS:',
    describeBehaviour(i.behaviour),
    i.blocked.length ? `\nRight now the host's limits do not allow: ${i.blocked.join('; ')}.` : '',
    '',
    i.prep ? `MEETING PREPARATION:\n${i.prep}\n` : '',
    agenda.length ? `AGENDA PROGRESS:\n${agenda.join('\n')}` : '',
    goal,
    renderCarryover(i.insights.carryover ?? null),
    '',
    'CURRENT NOTES:',
    renderNotes(i.insights) || '(none yet)',
    '',
    i.remarks.length
      ? 'YOUR RECENT REMARKS (made without being asked):\n' +
        i.remarks.map((r) => `- id ${r.id} (${ago(i.now, r.at)}, ${r.intent}, key "${r.topicKey}", ${r.reaction}): "${r.message}"`).join('\n')
      : 'YOUR RECENT REMARKS: none',
    renderLearning(i.learning),
    '',
    'RECENT TRANSCRIPT (UTC):',
    formatUtterances(i.transcript.slice(-i.behaviour.engine.contextLines), 'UTC') || '(empty)',
  ]
    .filter((l) => l !== '')
    .join('\n');
}

export type BrainFn = (input: BrainInput) => Promise<BrainDecision>;

export function geminiBrain(call: StructuredCall): BrainFn {
  return (input) => call(BrainDecision, { system: BRAIN_SYSTEM, prompt: brainPrompt(input), temperature: 0.4 });
}
