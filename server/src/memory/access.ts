import { MeetingModel } from '../models/Meeting.js';
import { MeetingInsightModel } from '../models/Insights.js';

/*
 * Who may see a meeting's content (notes, transcript, recordings, memory, analytics).
 *
 * Access is per SESSION, not per meeting link: a recurring link (weekly stand-up) has many sessions, and
 * joining one of them must not reveal the others. A user may see a session when they
 *   - host the meeting, or
 *   - were in that session: the AI recorded them as present (participantUserIds), or they were issued a
 *     join token for the meeting between shortly before the session started and when it ended.
 */

/** A join token issued this long before the session's first note still counts as attending it. */
export const ATTENDANCE_SLACK_MS = 15 * 60_000;

interface SessionLike {
  sessionId: string;
  meetingCode: string;
  startedAt?: Date | null;
  endedAt?: Date | null;
  updatedAt?: Date | null;
  participantUserIds?: readonly string[] | null;
}

interface MeetingLike {
  code: string;
  host: unknown;
  participants?: ArrayLike<{ user?: unknown; lastJoinedAt?: unknown; joins?: unknown }> | null;
}

function joinTimes(meeting: MeetingLike, uid: string): number[] {
  const p = Array.from(meeting.participants ?? []).find((x) => x.user && String(x.user) === uid);
  if (!p) return [];
  const joins = Array.isArray(p.joins) && p.joins.length ? (p.joins as unknown[]) : p.lastJoinedAt ? [p.lastJoinedAt] : [];
  return joins.map((d) => new Date(d as string | Date).getTime()).filter((t) => !Number.isNaN(t));
}

/** The time a session covers (open sessions run until now). */
export function sessionWindow(s: SessionLike, now = Date.now()): [number, number] {
  const start = s.startedAt ? new Date(s.startedAt).getTime() : 0;
  const end = s.endedAt ? new Date(s.endedAt).getTime() : now;
  return [start - ATTENDANCE_SLACK_MS, Math.max(end, s.updatedAt ? new Date(s.updatedAt).getTime() : 0)];
}

export function attended(uid: string, meeting: MeetingLike, s: SessionLike, now = Date.now()): boolean {
  if ((s.participantUserIds ?? []).includes(uid)) return true;
  const [from, to] = sessionWindow(s, now);
  return joinTimes(meeting, uid).some((t) => t >= from && t <= to);
}

export function canSeeSession(uid: string, meeting: MeetingLike, s: SessionLike, now = Date.now()): boolean {
  return String(meeting.host) === uid || attended(uid, meeting, s, now);
}

/** Was the user in this meeting at any time in [from, to]? (Recordings.) */
export function presentDuring(uid: string, meeting: MeetingLike, sessions: SessionLike[], from: number, to: number): boolean {
  if (String(meeting.host) === uid) return true;
  if (joinTimes(meeting, uid).some((t) => t >= from - ATTENDANCE_SLACK_MS && t <= to)) return true;
  return sessions.some((s) => {
    if (!(s.participantUserIds ?? []).includes(uid)) return false;
    const [a, b] = sessionWindow(s);
    return a <= to && b >= from;
  });
}

const SESSION_FIELDS = { sessionId: 1, meetingCode: 1, startedAt: 1, endedAt: 1, updatedAt: 1, participantUserIds: 1 } as const;

/** Every session the user may see, across all meetings. */
export async function accessibleSessions(userId: string, limit = 5000): Promise<Array<{ sessionId: string; meetingCode: string }>> {
  const meetings = (await MeetingModel.find({ $or: [{ host: userId }, { 'participants.user': userId }] })
    .select({ code: 1, host: 1, participants: 1 })
    .lean()) as unknown as MeetingLike[];
  const byCode = new Map(meetings.map((m) => [m.code, m]));
  const sessions = (await MeetingInsightModel.find({ $or: [{ meetingCode: { $in: [...byCode.keys()] } }, { participantUserIds: userId }] })
    .sort({ startedAt: -1 })
    .limit(limit)
    .select(SESSION_FIELDS)
    .lean()) as unknown as SessionLike[];
  // Meetings only known through "heard in a session".
  const missing = [...new Set(sessions.map((s) => s.meetingCode))].filter((c) => !byCode.has(c));
  if (missing.length) {
    for (const m of (await MeetingModel.find({ code: { $in: missing } }).select({ code: 1, host: 1, participants: 1 }).lean()) as unknown as MeetingLike[]) {
      byCode.set(m.code, m);
    }
  }
  const now = Date.now();
  return sessions
    .filter((s) => {
      const m = byCode.get(s.meetingCode);
      return m ? canSeeSession(userId, m, s, now) : (s.participantUserIds ?? []).includes(userId);
    })
    .map((s) => ({ sessionId: s.sessionId, meetingCode: s.meetingCode }));
}

export async function accessibleSessionIds(userId: string): Promise<string[]> {
  return (await accessibleSessions(userId)).map((s) => s.sessionId);
}

/**
 * Meeting codes the user has any visible session in (or hosts). Use only to pre-filter; content queries
 * must also filter by session (accessibleSessionIds).
 */
export async function accessibleMeetingCodes(userId: string): Promise<string[]> {
  const [own, sessions] = await Promise.all([
    MeetingModel.find({ host: userId }).select({ code: 1 }).lean(),
    accessibleSessions(userId),
  ]);
  return [...new Set([...own.map((m) => m.code), ...sessions.map((s) => s.meetingCode)])];
}

/** What a user may search and aggregate: session content by session id; documents by meeting. */
export interface AccessScope {
  meetingCodes: string[];
  sessionIds: string[];
}

export async function accessScope(userId: string): Promise<AccessScope> {
  const [own, sessions] = await Promise.all([MeetingModel.find({ host: userId }).select({ code: 1 }).lean(), accessibleSessions(userId)]);
  return {
    meetingCodes: [...new Set([...own.map((m) => m.code), ...sessions.map((x) => x.meetingCode)])],
    sessionIds: sessions.map((x) => x.sessionId),
  };
}
