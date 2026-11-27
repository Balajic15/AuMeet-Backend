import { MeetingModel } from '../models/Meeting.js';
import { MeetingInsightModel } from '../models/Insights.js';

/**
 * Meeting codes whose content a user may see: meetings they host, joined with their
 * account, or were heard speaking in. Same rule as the per-meeting insights page.
 */
export async function accessibleMeetingCodes(userId: string): Promise<string[]> {
  const [own, spoke] = await Promise.all([
    MeetingModel.find({ $or: [{ host: userId }, { 'participants.user': userId }] }).select({ code: 1 }).lean(),
    MeetingInsightModel.distinct('meetingCode', { participantUserIds: userId }),
  ]);
  return [...new Set([...own.map((m) => m.code), ...(spoke as string[])])];
}
