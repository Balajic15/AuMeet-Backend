import mongoose from 'mongoose';
import { MeetingInsightModel, TranscriptLineModel } from '../models/Insights.js';
import { MemoryChunkModel } from '../models/MemoryChunk.js';
import { deleteRecordings } from '../services/recording.js';

/**
 * Deletes meeting content older than `days` (transcripts, AI notes, recaps, memory and recordings).
 * Accounts and the meetings themselves (title, link, schedule) are kept.
 */
export async function purgeOldContent(days: number, now = new Date()) {
  if (days <= 0) return { transcripts: 0, sessions: 0, chunks: 0, recordings: 0 };
  const cutoff = new Date(now.getTime() - days * 24 * 60 * 60 * 1000);
  const [t, s, c, r] = await Promise.all([
    TranscriptLineModel.deleteMany({ at: { $lt: cutoff } }),
    MeetingInsightModel.deleteMany({ startedAt: { $lt: cutoff } }),
    MemoryChunkModel.deleteMany({ startedAt: { $lt: cutoff } }),
    deleteRecordings({ startedAt: { $lt: cutoff }, status: { $ne: 'active' } }),
    mongoose.connection.collection('ai_corrections').deleteMany({ at: { $lt: cutoff } }),
    mongoose.connection.collection('follow_actions').deleteMany({ createdAt: { $lt: cutoff } }),
  ]);
  return { transcripts: t.deletedCount, sessions: s.deletedCount, chunks: c.deletedCount, recordings: r };
}
