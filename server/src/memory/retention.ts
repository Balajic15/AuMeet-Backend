import { MeetingInsightModel, TranscriptLineModel } from '../models/Insights.js';
import { MemoryChunkModel } from '../models/MemoryChunk.js';

/**
 * Deletes meeting content older than `days` (transcripts, AI notes, recaps and memory).
 * Accounts and the meetings themselves (title, link, schedule) are kept.
 */
export async function purgeOldContent(days: number, now = new Date()) {
  if (days <= 0) return { transcripts: 0, sessions: 0, chunks: 0 };
  const cutoff = new Date(now.getTime() - days * 24 * 60 * 60 * 1000);
  const [t, s, c] = await Promise.all([
    TranscriptLineModel.deleteMany({ at: { $lt: cutoff } }),
    MeetingInsightModel.deleteMany({ startedAt: { $lt: cutoff } }),
    MemoryChunkModel.deleteMany({ startedAt: { $lt: cutoff } }),
  ]);
  return { transcripts: t.deletedCount, sessions: s.deletedCount, chunks: c.deletedCount };
}
