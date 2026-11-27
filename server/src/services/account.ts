import { MeetingModel } from '../models/Meeting.js';
import { MeetingInsightModel, TranscriptLineModel } from '../models/Insights.js';
import { MemoryChunkModel } from '../models/MemoryChunk.js';
import { UserModel } from '../models/User.js';
import { closeRoom } from './livekit.js';

/**
 * Deletes an account and the data that belongs to it:
 * - meetings the user hosted are ended and removed with all their transcripts, notes and memory;
 * - in other people's meetings, their name is replaced and links to their account are removed
 *   (the other participants keep their own record of the meeting).
 */
export async function deleteAccount(userId: string): Promise<{ meetingsDeleted: number }> {
  const hosted = await MeetingModel.find({ host: userId }).select({ code: 1, status: 1 }).lean();
  const codes = hosted.map((m) => m.code);

  await Promise.all(hosted.filter((m) => m.status === 'live').map((m) => closeRoom(m.code)));
  await Promise.all([
    MemoryChunkModel.deleteMany({ meetingCode: { $in: codes } }),
    TranscriptLineModel.deleteMany({ meetingCode: { $in: codes } }),
    MeetingInsightModel.deleteMany({ meetingCode: { $in: codes } }),
    MeetingModel.deleteMany({ host: userId }),
  ]);

  // Other people's meetings: anonymise.
  await Promise.all([
    TranscriptLineModel.updateMany({ userId }, { $set: { speakerName: 'Former member', userId: null } }),
    MeetingModel.updateMany(
      { 'participants.user': userId },
      { $set: { 'participants.$[p].name': 'Former member' }, $unset: { 'participants.$[p].user': 1 } },
      { arrayFilters: [{ 'p.user': userId }] },
    ),
    MeetingInsightModel.updateMany(
      { 'insights.actionItems.ownerUserId': userId },
      { $set: { 'insights.actionItems.$[a].ownerUserId': null, 'insights.actionItems.$[a].ownerIdentity': null } },
      { arrayFilters: [{ 'a.ownerUserId': userId }] },
    ),
    MeetingInsightModel.updateMany({ participantUserIds: userId }, { $pull: { participantUserIds: userId } }),
  ]);

  await UserModel.deleteOne({ _id: userId });
  return { meetingsDeleted: hosted.length };
}
