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
  keyPoints: z
    .array(
      z.object({
        id: Str.describe('Existing id to keep, or "" for a new point'),
        point: Str.describe('An important piece of information, insight or concern raised (not a decision or task)'),
        importance: z.enum(['high', 'normal']),
        evidence: Evidence,
      }),
    )
    .optional(),
  assumptions: z
    .array(
      z.object({
        id: Str.describe('Existing id to keep, or "" for a new assumption'),
        statement: Str.describe('Something the group is treating as true without having confirmed it'),
        madeBy: Str.describe('Name, or ""'),
        status: z.enum(['unverified', 'confirmed', 'invalidated']),
        evidence: Evidence,
      }),
    )
    .optional(),
  risks: z
    .array(
      z.object({
        id: Str.describe('Existing id to keep, or "" for a new risk'),
        kind: z.enum(['conflict', 'dependency', 'deadline', 'blocker', 'contradiction', 'other']),
        description: Str.describe('The problem in one sentence, naming the clashing statements, e.g. "Asha commits to Friday but the API Ben needs arrives Monday"'),
        involves: Names,
        relatedItems: z.array(Str).describe('Ids of related tasks/decisions in the notes (t1, d2, …)'),
        earlierRef: Str.describe('Id (E1, E2, …) of an EARLIER OPEN ITEM this repeats or depends on, otherwise ""'),
        severity: z.enum(['low', 'medium', 'high']),
        suggestedQuestion: Str.describe('A short clarifying question that would resolve it, or ""'),
        status: z.enum(['open', 'resolved']),
        evidence: Evidence,
      }),
    )
    .optional(),
  copilot: z
    .object({
      currentFocus: Str.describe('What the group is discussing right now, in a few words'),
      offTopic: z.boolean().describe('true when the current discussion has wandered away from the goal/agenda/purpose'),
      offTopicNote: Str.describe('If offTopic, one short sentence on what it drifted to; otherwise ""'),
      missingInfo: z.array(Str).describe('Information the group needs but has not got yet (owner, date, numbers, criteria …)'),
      suggestedQuestions: z.array(Str).describe('Up to 3 questions a participant could ask now to move things forward'),
      discussNext: Str.describe('What the team should discuss next and why, in one sentence, or ""'),
      agendaAdvice: Str.describe('With an agenda and time plan: a concrete adjustment for the remaining time (e.g. "Shorten item 3, park item 4"), or ""'),
    })
    .optional(),
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
  /** When it first became agreed or rejected (for decision-time analytics). */
  settledAt?: string | null;
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

export interface KeyPoint {
  id: string;
  point: string;
  importance: 'high' | 'normal';
  evidence: number[];
}

export interface Assumption {
  id: string;
  statement: string;
  madeBy: string | null;
  status: 'unverified' | 'confirmed' | 'invalidated';
  evidence: number[];
}

export type RiskKind = 'conflict' | 'dependency' | 'deadline' | 'blocker' | 'contradiction' | 'other';

export interface Risk {
  id: string;
  kind: RiskKind;
  description: string;
  involves: string[];
  relatedItems: string[];
  /** An open item from an earlier meeting this repeats or depends on. */
  earlier: EarlierItemRef | null;
  severity: 'low' | 'medium' | 'high';
  suggestedQuestion: string | null;
  status: 'open' | 'resolved';
  evidence: number[];
  firstSeenAt: string;
  updatedAt: string;
}

/** An open task or risk from an earlier meeting (for spotting repeated blockers and dependencies). */
export interface EarlierItemRef {
  /** Short id used in the prompt, e.g. "E3". */
  ref: string;
  kind: 'task' | 'risk';
  text: string;
  owner: string | null;
  dueDate: string | null;
  /** YYYY-MM-DD */
  date: string;
  title: string;
}

/** Live, non-intrusive guidance for the participants (replaced on every analysis). */
export interface Copilot {
  currentFocus: string;
  offTopic: boolean;
  offTopicNote: string;
  missingInfo: string[];
  suggestedQuestions: string[];
  discussNext: string;
  agendaAdvice: string;
  updatedAt: string;
}

export interface Insights {
  summary: string;
  keyPoints?: KeyPoint[];
  assumptions?: Assumption[];
  risks?: Risk[];
  copilot?: Copilot | null;
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
    keyPoints: [],
    assumptions: [],
    risks: [],
    copilot: null,
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
