import { z } from 'zod';
import type { AiClient } from '../ai/gemini.js';
import { MemoryChunkModel } from '../models/MemoryChunk.js';
import { env } from '../config/env.js';
import { logger } from '../logger.js';

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
export async function searchMemory(ai: AiClient, meetingCodes: string[], query: string, k = 8): Promise<MemoryHit[]> {
  if (meetingCodes.length === 0 || !query.trim()) return [];
  const [q] = await ai.embed([query], 'query');
  if (!q) return [];

  if (env.MEMORY_VECTOR_INDEX) {
    try {
      return await atlasVectorSearch(env.MEMORY_VECTOR_INDEX, q, meetingCodes, k);
    } catch (err) {
      // Index missing/building, or not on Atlas: fall back to in-app search.
      logger.warn({ err }, 'Atlas vector search failed – using in-app search');
    }
  }

  const chunks = await MemoryChunkModel.find({ meetingCode: { $in: meetingCodes } })
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

export const ANSWER_SYSTEM = `You answer questions about a team's past meetings using ONLY the numbered excerpts.
- If the excerpts don't contain the answer, say you couldn't find it in their meetings. Don't guess.
- Be precise about status: say whether something was agreed, only proposed, or still unresolved.
- Mention which meeting and date the answer comes from when useful.
- Answer in the language of the question. Plain text, no markdown.`;

export function answerPrompt(question: string, hits: MemoryHit[]): string {
  const excerpts = hits.map((h, i) => `[${i + 1}] ${h.text}`).join('\n\n');
  return `QUESTION: ${question}\n\nEXCERPTS:\n${excerpts}`;
}
