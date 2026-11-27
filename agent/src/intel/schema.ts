import { z } from 'zod';

/*
 * Two shapes:
 *  - ModelOutput: what Gemini returns. Kept JSON-Schema simple (no nullables/unions):
 *    "" means "none" and id "" means "new item".
 *  - Insights: the normalised state we store, broadcast, and show in the UI.
 */

const Str = z.string();
const Names = z.array(z.string()).describe('Participant names exactly as they appear in the transcript');
const Evidence = z.array(z.number().int()).describe('Transcript line numbers (#n) that support this item');

export const ModelOutput = z.object({
  summary: Str.describe('2-4 sentence running summary of the meeting so far'),
  topics: z.array(
    z.object({
      id: Str.describe('Existing id to keep, or "" for a new topic'),
      title: Str,
      status: z.enum(['active', 'closed']),
    }),
  ),
  decisions: z.array(
    z.object({
      id: Str.describe('Existing id to keep, or "" for a new decision'),
      topic: Str,
      statement: Str.describe(
        'What was decided, e.g. "Use PostgreSQL for the main database". For undecided items, the question being decided, e.g. "Which database to use".',
      ),
      status: z.enum(['proposed', 'agreed', 'disputed', 'rejected']),
      options: z.array(Str).describe('Competing options when people disagree, e.g. ["MongoDB", "PostgreSQL"]'),
      proposedBy: Names,
      supporters: Names,
      objectors: Names,
      confirmationNeeded: Str.describe(
        'If the group should be asked to confirm, the exact question to ask; otherwise ""',
      ),
      contradicts: Str.describe(
        'Id of an EARLIER AGREED DECISION (e.g. "P2") that this decision reverses, replaces or conflicts with; otherwise ""',
      ),
      evidence: Evidence,
    }),
  ),
  actionItems: z.array(
    z.object({
      id: Str.describe('Existing id to keep, or "" for a new task'),
      task: Str,
      owner: Str.describe('Name of the person responsible, or "" if nobody took it'),
      deadline: Str.describe('Deadline as said, e.g. "by Friday", or ""'),
      dueDate: Str.describe('Deadline resolved to YYYY-MM-DD using the meeting date, or "" if unclear'),
      status: z.enum(['open', 'done']),
      evidence: Evidence,
    }),
  ),
  openQuestions: z.array(
    z.object({
      id: Str.describe('Existing id to keep, or "" for a new question'),
      question: Str,
      askedBy: Str.describe('Name, or ""'),
      status: z.enum(['open', 'answered']),
      evidence: Evidence,
    }),
  ),
  progress: z
    .object({
      goalStatus: z
        .enum(['no_goal', 'on_track', 'drifting', 'off_track', 'achieved'])
        .describe('How the discussion relates to the MEETING GOAL; "no_goal" when there is none'),
      goalReason: Str.describe('One short sentence explaining the goal status, or ""'),
      agenda: z.array(
        z.object({
          id: Str.describe('Agenda item id exactly as given'),
          status: z.enum(['not_started', 'in_progress', 'done', 'skipped']),
          note: Str.describe('Very short note on what was concluded, or ""'),
        }),
      ),
    })
    .optional(),
});
export type ModelOutput = z.infer<typeof ModelOutput>;

export type AgendaStatus = 'not_started' | 'in_progress' | 'done' | 'skipped';
export type GoalStatus = 'no_goal' | 'on_track' | 'drifting' | 'off_track' | 'achieved';

export interface AgendaProgress {
  id: string;
  title: string;
  minutes: number | null;
  status: AgendaStatus;
  note: string;
  /** First time the item was seen being discussed / finished (ISO). */
  startedAt: string | null;
  doneAt: string | null;
}

export interface GoalProgress {
  text: string;
  status: GoalStatus;
  reason: string;
  /** When the current status began (ISO) – e.g. how long the meeting has been off track. */
  since: string;
}

export type DecisionStatus = ModelOutput['decisions'][number]['status'];

export interface Topic {
  id: string;
  title: string;
  status: 'active' | 'closed';
}

export interface Decision {
  id: string;
  topic: string;
  statement: string;
  status: DecisionStatus;
  options: string[];
  proposedBy: string[];
  supporters: string[];
  objectors: string[];
  confirmationNeeded: string | null;
  /** An earlier meeting's agreed decision that this one goes against. */
  contradicts?: PastDecisionRef | null;
  evidence: number[];
  firstSeenAt: string;
  updatedAt: string;
}

/** An agreed decision from an earlier meeting (for spotting contradictions). */
export interface PastDecisionRef {
  /** Short id used in the prompt, e.g. "P2". */
  ref: string;
  statement: string;
  /** YYYY-MM-DD */
  date: string;
  title: string;
}

/** Unfinished business from the previous meeting, shown at the start of this one. */
export interface Carryover {
  fromTitle: string;
  /** YYYY-MM-DD */
  fromDate: string;
  decisions: Array<{ statement: string; options: string[] }>;
  tasks: Array<{ task: string; owner: string | null; dueDate: string | null; overdue: boolean }>;
}

export interface ActionItem {
  id: string;
  task: string;
  owner: string | null;
  /** LiveKit identity of the owner when matched to a participant. */
  ownerIdentity: string | null;
  /** Account id of the owner (null for guests / unmatched). */
  ownerUserId: string | null;
  deadline: string | null;
  dueDate: string | null;
  status: 'open' | 'done';
  evidence: number[];
  firstSeenAt: string;
  updatedAt: string;
}

export interface OpenQuestion {
  id: string;
  question: string;
  askedBy: string | null;
  status: 'open' | 'answered';
  evidence: number[];
}

export interface Insights {
  summary: string;
  topics: Topic[];
  decisions: Decision[];
  actionItems: ActionItem[];
  openQuestions: OpenQuestion[];
  /** Only when the host set a goal / agenda. */
  goal: GoalProgress | null;
  agenda: AgendaProgress[];
  /** Open items from the previous meeting (null when there are none). */
  carryover?: Carryover | null;
  /** Highest transcript line number included in the last analysis. */
  analyzedThrough: number;
  updatedAt: string;
}

export function emptyInsights(): Insights {
  return {
    summary: '',
    topics: [],
    decisions: [],
    actionItems: [],
    openQuestions: [],
    goal: null,
    agenda: [],
    carryover: null,
    analyzedThrough: 0,
    updatedAt: new Date(0).toISOString(),
  };
}

/** JSON Schema handed to Gemini's structured output. */
export function modelOutputJsonSchema(): Record<string, unknown> {
  const schema = z.toJSONSchema(ModelOutput, { target: 'draft-7' }) as Record<string, unknown>;
  delete schema['$schema'];
  return schema;
}
