import type { AiClient } from '../ai/gemini.js';
import { MeetingInsightModel, TranscriptLineModel } from '../models/Insights.js';
import { MemoryChunkModel } from '../models/MemoryChunk.js';
import { MeetingModel } from '../models/Meeting.js';
import { buildChunks } from './chunks.js';
import { RECAP_SYSTEM, RecapOutput, recapPrompt } from './recap.js';
import type { Recap, SessionDoc, TranscriptRow } from './types.js';

/** A session is retried this many times before the sweep gives up on it. */
export const MAX_ATTEMPTS = 3;
/** Sessions the agent never closed (crash) are processed after this much inactivity. */
export const STALE_AFTER_MS = 2 * 60 * 60 * 1000;

/** Sessions that ended (or went stale) and haven't been turned into memory yet. */
export async function findSessionsToProcess(now = new Date(), limit = 20): Promise<string[]> {
  const docs = await MeetingInsightModel.find({
    memoryIndexedAt: { $exists: false },
    memoryAttempts: { $not: { $gte: MAX_ATTEMPTS } },
    $or: [{ endedAt: { $exists: true } }, { updatedAt: { $lt: new Date(now.getTime() - STALE_AFTER_MS) } }],
  })
    .sort({ updatedAt: 1 })
    .limit(limit)
    .select({ sessionId: 1 })
    .lean();
  return docs.map((d) => d.sessionId);
}

/**
 * Recap + memory index for one session. Idempotent: re-running replaces the session's chunks.
 * Returns what was produced (for logs/tests).
 */
export async function processSession(
  sessionId: string,
  ai: AiClient,
  now = new Date(),
): Promise<{ recap: Recap | null; chunks: number; skipped?: string }> {
  await MeetingInsightModel.updateOne({ sessionId }, { $inc: { memoryAttempts: 1 } });
  const session = (await MeetingInsightModel.findOne({ sessionId }).lean()) as SessionDoc | null;
  if (!session) return { recap: null, chunks: 0, skipped: 'session not found' };

  const lines = (await TranscriptLineModel.find({ sessionId, meetingCode: session.meetingCode })
    .sort({ seq: 1 })
    .select({ _id: 0, seq: 1, speakerName: 1, isAgent: 1, channel: 1, text: 1, at: 1 })
    .lean()) as TranscriptRow[];

  const humanLines = lines.filter((l) => !l.isAgent);
  const hasNotes = !!(session.insights?.summary || session.insights?.decisions?.length || session.insights?.actionItems?.length);
  if (humanLines.length === 0 && !hasNotes) {
    await MeetingInsightModel.updateOne({ sessionId }, { $set: { memoryIndexedAt: now }, $unset: { memoryError: 1 } });
    return { recap: null, chunks: 0, skipped: 'nothing was said' };
  }

  try {
    const meeting = await MeetingModel.findOne({ code: session.meetingCode }).select({ prep: 1 }).lean();
    const prep = { goal: meeting?.prep?.goal ?? '', agenda: meeting?.prep?.agenda ?? [] };
    const out = await ai.structured(RecapOutput, { system: RECAP_SYSTEM, prompt: recapPrompt(session, lines, prep), temperature: 0.2 });
    const recap: Recap = {
      headline: out.headline.trim(),
      overview: out.overview.trim(),
      highlights: out.highlights.map((h) => h.trim()).filter(Boolean).slice(0, 6),
      nextSteps: out.nextSteps.map((h) => h.trim()).filter(Boolean).slice(0, 6),
      goalOutcome: prep.goal && out.goalOutcome && out.goalOutcome.status !== 'no_goal'
        ? { status: out.goalOutcome.status, summary: out.goalOutcome.summary.trim() }
        : null,
      generatedAt: now.toISOString(),
    };

    const drafts = buildChunks(session, lines, recap);
    const vectors = drafts.length ? await ai.embed(drafts.map((d) => d.text), 'document') : [];

    await MemoryChunkModel.deleteMany({ sessionId });
    if (drafts.length) {
      await MemoryChunkModel.insertMany(
        drafts.map((d, i) => ({
          meetingCode: session.meetingCode,
          sessionId,
          title: session.title ?? 'Untitled meeting',
          startedAt: session.startedAt,
          kind: d.kind,
          ref: d.ref,
          text: d.text,
          embedding: vectors[i],
        })),
      );
    }

    await MeetingInsightModel.updateOne(
      { sessionId },
      { $set: { recap, memoryIndexedAt: now }, $unset: { memoryError: 1 } },
    );
    return { recap, chunks: drafts.length };
  } catch (err) {
    await MeetingInsightModel.updateOne({ sessionId }, { $set: { memoryError: String((err as Error).message ?? err) } });
    throw err;
  }
}
