import { env } from '../config/env.js';
import { logger } from '../logger.js';
import { MeetingInsightModel } from '../models/Insights.js';
import { MeetingModel } from '../models/Meeting.js';
import { UserModel } from '../models/User.js';
import { emailHtml, escapeHtml, mailConfigured, sendMail } from '../services/mailer.js';
import type { Recap, SessionDoc, StoredActionItem } from './types.js';

/*
 * After a meeting: everyone with an account who attended gets the recap, with their own tasks first.
 * Only VERIFIED addresses: an unverified account could name someone else's address, and the recap
 * would leak the meeting to a person who wasn't there.
 */

const GOAL_LABEL: Record<string, string> = { met: 'Goal met', partly_met: 'Goal partly met', not_met: 'Goal not met' };
/** Joined at most this long before the session's first note counts as attending this session. */
const ATTENDANCE_SLACK_MS = 15 * 60_000;

const day = (d?: Date) =>
  d ? new Date(d).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' }) : '';

function taskLine(a: StoredActionItem): string {
  return `${a.task}${a.owner ? ` – ${a.owner}` : ' – no owner yet'}${a.dueDate ? `, due ${a.dueDate}` : a.deadline ? `, ${a.deadline}` : ''}`;
}

export function isOwnTask(a: StoredActionItem, user: { id: string; name: string }): boolean {
  if (a.ownerUserId) return a.ownerUserId === user.id;
  if (!a.owner) return false;
  const owner = a.owner.trim().toLowerCase();
  const name = user.name.trim().toLowerCase();
  return owner === name || owner === name.split(/\s+/)[0];
}

export function followUpEmail(
  session: Pick<SessionDoc, 'title' | 'startedAt' | 'insights' | 'meetingCode'>,
  recap: Recap,
  user: { id: string; name: string },
  link: string,
) {
  const title = session.title || 'Meeting';
  const decisions = session.insights?.decisions ?? [];
  const agreed = decisions.filter((d) => d.status === 'agreed').map((d) => d.statement);
  const undecided = decisions.filter((d) => d.status === 'disputed' || d.status === 'proposed').map((d) => d.statement);
  const open = (session.insights?.actionItems ?? []).filter((a) => a.status === 'open');
  const mine = open.filter((a) => isOwnTask(a, user));
  const others = open.filter((a) => !isOwnTask(a, user));
  const questions = (session.insights?.openQuestions ?? []).filter((q) => q.status === 'open').map((q) => q.question);

  const sections: Array<[string, string[]]> = [
    ['Your tasks', mine.map(taskLine)],
    ['Decided', agreed],
    ['Still undecided', undecided],
    ['Other tasks', others.map(taskLine)],
    ['Open questions', questions],
  ];
  const goal = recap.goalOutcome && GOAL_LABEL[recap.goalOutcome.status];

  const text = [
    `${title} – ${day(session.startedAt)}`,
    '',
    recap.headline,
    recap.overview,
    goal ? `\n${goal}: ${recap.goalOutcome!.summary}` : '',
    ...sections.filter(([, xs]) => xs.length).map(([h, xs]) => `\n${h}:\n${xs.map((x) => `- ${x}`).join('\n')}`),
    `\nFull notes and transcript: ${link}`,
    '\nYou get this because you attended. The host can turn these emails off in the meeting settings.',
  ]
    .filter((l) => l !== '')
    .join('\n');

  const list = (xs: string[]) => `<ul style="margin:6px 0 16px;padding-left:20px">${xs.map((x) => `<li style="margin:3px 0">${escapeHtml(x)}</li>`).join('')}</ul>`;
  const html = emailHtml(
    `${title} – recap`,
    `<p style="margin:0 0 4px;color:#9a9a9a">${escapeHtml(day(session.startedAt))}</p>` +
      `<p style="margin:12px 0"><strong>${escapeHtml(recap.headline)}</strong></p>` +
      `<p style="margin:0 0 16px">${escapeHtml(recap.overview)}</p>` +
      (goal ? `<p style="margin:0 0 16px"><strong>${escapeHtml(goal)}:</strong> ${escapeHtml(recap.goalOutcome!.summary)}</p>` : '') +
      sections
        .filter(([, xs]) => xs.length)
        .map(([h, xs]) => `<p style="margin:16px 0 0;font-weight:600;color:#ffffff">${escapeHtml(h)}</p>${list(xs)}`)
        .join('') +
      '<p style="margin:20px 0 0;font-size:12px;color:#8a8a8a">You get this because you attended. The host can turn these emails off in the meeting settings.</p>',
    { label: 'Open the meeting notes', url: link },
  );

  return {
    subject: mine.length ? `${title}: recap and your ${mine.length === 1 ? 'task' : `${mine.length} tasks`}` : `${title}: recap`,
    text,
    html,
  };
}

/** Sends the recap once per session. Returns how many emails went out. */
export async function sendFollowUps(sessionId: string, now = new Date()): Promise<{ sent: number; skipped?: string }> {
  if (!mailConfigured()) return { sent: 0, skipped: 'email not configured' };
  const session = (await MeetingInsightModel.findOne({ sessionId }).lean()) as (SessionDoc & { followUpSentAt?: Date }) | null;
  if (!session?.recap) return { sent: 0, skipped: 'no recap' };
  if (session.followUpSentAt) return { sent: 0, skipped: 'already sent' };

  const meeting = await MeetingModel.findOne({ code: session.meetingCode }).select({ settings: 1, participants: 1 }).lean();
  if (!meeting || meeting.settings?.followUpEmail === false) return { sent: 0, skipped: 'turned off by host' };

  // Claim the session first so a retry or a second worker never sends twice.
  const claimed = await MeetingInsightModel.updateOne(
    { sessionId, followUpSentAt: { $exists: false } },
    { $set: { followUpSentAt: now } },
  );
  if (claimed.modifiedCount === 0) return { sent: 0, skipped: 'already sent' };

  const since = session.startedAt ? new Date(session.startedAt).getTime() - ATTENDANCE_SLACK_MS : 0;
  const attendees = new Set<string>(session.participantUserIds ?? []);
  for (const p of meeting.participants ?? []) {
    if (p.user && p.lastJoinedAt && new Date(p.lastJoinedAt).getTime() >= since) attendees.add(String(p.user));
  }
  if (attendees.size === 0) return { sent: 0, skipped: 'no attendees with an account' };

  const users = await UserModel.find({ _id: { $in: [...attendees] }, emailVerified: true }).select({ name: 1, email: 1 }).lean();
  const link = `${env.WEB_URL.replace(/\/$/, '')}/${session.meetingCode}/insights`;
  let sent = 0;
  for (const u of users) {
    try {
      const mail = followUpEmail(session, session.recap, { id: String(u._id), name: u.name }, link);
      if (await sendMail({ to: u.email, ...mail })) sent++;
    } catch (err) {
      logger.warn({ err, sessionId }, 'follow-up email failed for one recipient');
    }
  }
  return { sent };
}
