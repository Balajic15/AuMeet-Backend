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
});
export type ModelOutput = z.infer<typeof ModelOutput>;

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
  evidence: number[];
  firstSeenAt: string;
  updatedAt: string;
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
