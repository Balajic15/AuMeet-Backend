import { z } from 'zod';
import { fence, UNTRUSTED_RULES } from '../ai/untrusted.js';
import type { AiClient } from '../ai/gemini.js';
import { MemoryChunkModel } from '../models/MemoryChunk.js';
import { env } from '../config/env.js';
import { logger } from '../logger.js';
import type { AccessScope } from './access.js';

export interface MemoryHit {
  meetingCode: string;
  sessionId: string;
  title: string;
  startedAt: Date | null;
  kind: string;
  text: string;
  score: number;
}

/** Most recent chunks considered per search – keeps memory/latency bounded. */
const SCAN_LIMIT = 5000;
/** Below this similarity a chunk is noise, not a match. */
const MIN_SCORE = 0.35;

export function dot(a: number[], b: number[]): number {
  let s = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) s += a[i]! * b[i]!;
  return s;
}

/** Semantic search over the given meetings (embeddings are unit-length, so dot = cosine). */
/** Session chunks only from sessions the user may see; documents from their meetings. */
const scopeFilter = (scope: AccessScope) => ({
  meetingCode: { $in: scope.meetingCodes },
  $or: [{ sessionId: { $in: scope.sessionIds } }, { kind: 'document' }],
});
const inScope = (scope: AccessScope) => {
  const sessions = new Set(scope.sessionIds);
  const codes = new Set(scope.meetingCodes);
  return (h: { meetingCode: string; sessionId: string; kind: string }) => codes.has(h.meetingCode) && (sessions.has(h.sessionId) || h.kind === 'document');
};

export async function searchMemory(ai: AiClient, scope: AccessScope, query: string, k = 8): Promise<MemoryHit[]> {
  if (scope.meetingCodes.length === 0 || !query.trim()) return [];
  const meetingCodes = scope.meetingCodes;
  const [q] = await ai.embed([query], 'query');
  if (!q) return [];

  if (env.MEMORY_VECTOR_INDEX) {
    try {
      // The index filters by meeting; sessions are filtered here.
      return (await atlasVectorSearch(env.MEMORY_VECTOR_INDEX, q, meetingCodes, k * 4)).filter(inScope(scope)).slice(0, k);
    } catch (err) {
      // Index missing/building, or not on Atlas: fall back to in-app search.
      logger.warn({ err }, 'Atlas vector search failed – using in-app search');
    }
  }

  const chunks = await MemoryChunkModel.find(scopeFilter(scope) as never)
    .sort({ startedAt: -1 })
    .limit(SCAN_LIMIT)
    .select({ meetingCode: 1, sessionId: 1, title: 1, startedAt: 1, kind: 1, text: 1, embedding: 1 })
    .lean();

  return chunks
    .map((c) => ({
      meetingCode: c.meetingCode,
      sessionId: c.sessionId,
      title: c.title,
      startedAt: c.startedAt ?? null,
      kind: c.kind,
      text: c.text,
      score: dot(q, c.embedding as number[]),
    }))
    .filter((h) => h.score >= MIN_SCORE)
    .sort((a, b) => b.score - a.score)
    .slice(0, k);
}

/**
 * MongoDB Atlas Vector Search. Requires an index named MEMORY_VECTOR_INDEX on `memory_chunks`:
 *   { "fields": [ { "type": "vector", "path": "embedding", "numDimensions": 768, "similarity": "cosine" },
 *                 { "type": "filter", "path": "meetingCode" } ] }
 */
async function atlasVectorSearch(index: string, q: number[], meetingCodes: string[], k: number): Promise<MemoryHit[]> {
  const rows = await MemoryChunkModel.aggregate<MemoryHit & { _id: unknown }>([
    {
      $vectorSearch: {
        index,
        path: 'embedding',
        queryVector: q,
        numCandidates: Math.max(100, k * 20),
        limit: k * 2,
        filter: { meetingCode: { $in: meetingCodes } },
      },
    },
    {
      $project: {
        meetingCode: 1, sessionId: 1, title: 1, startedAt: 1, kind: 1, text: 1,
        score: { $meta: 'vectorSearchScore' },
      },
    },
  ]);
  // Atlas cosine scores are normalised to 0..1 ((1 + cos) / 2); convert back for one threshold.
  return rows
    .map(({ _id, ...h }) => ({ ...h, startedAt: h.startedAt ?? null, score: h.score * 2 - 1 }))
    .filter((h) => h.score >= MIN_SCORE)
    .slice(0, k);
}

export const AnswerOutput = z.object({
  answer: z.string().describe('Direct answer in 1-4 sentences, or say the meetings do not cover it'),
  sources: z.array(z.number().int()).describe('Numbers of the excerpts the answer relies on'),
});

export const ANSWER_SYSTEM = `You answer questions about a team's past meetings using ONLY the numbered excerpts and the STATUS LEDGER.
- The STATUS LEDGER is the current, authoritative record of tasks (owner, due date, open/done/overdue), decisions
  (agreed/proposed/disputed/rejected) and open risks. Use it for who owns what, deadlines, progress and what is pending;
  use the excerpts for context and wording. Later meetings supersede earlier ones.
- If neither contains the answer, say you couldn't find it in their meetings. Don't guess.
- Be precise about status: say whether something was agreed, only proposed, or still unresolved.
- Mention which meeting and date the answer comes from when useful.
- Answer in the language of the question. Plain text, no markdown.

${UNTRUSTED_RULES}`;

export function answerPrompt(question: string, hits: MemoryHit[], ledger = ''): string {
  const excerpts = hits.map((h, i) => `[${i + 1}] ${h.text}`).join('\n\n');
  return [
    `QUESTION: ${question}`,
    '',
    fence('EXCERPTS', excerpts || '(none)'),
    ledger ? `\n${fence('STATUS LEDGER (newest meetings first)', ledger)}` : '',
  ].join('\n');
}
