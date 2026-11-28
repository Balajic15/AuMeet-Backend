import { z } from 'zod';
import { fence, UNTRUSTED_RULES } from '../ai/untrusted.js';
import type { AiClient } from '../ai/gemini.js';
import { MeetingInsightModel, TranscriptLineModel } from '../models/Insights.js';
import type { SessionDoc } from '../memory/types.js';

/*
 * Meeting effectiveness, measured from what the AI already records: who spoke and for how long,
 * how much of the agenda got done, how long decisions took, what was left unresolved, and whether
 * the tasks agreed in meetings actually get done. Per meeting, over time, and compared with the
 * previous period.
 */

/** Speaking rate used only when a line has no measured voice duration (chat, older transcripts). */
const WORDS_PER_SECOND = 2.5;

export interface SpeakerStat {
  name: string;
  lines: number;
  words: number;
  seconds: number;
  /** Share of the meeting's speaking time, 0..1. */
  share: number;
}

export interface SessionMetrics {
  sessionId: string;
  meetingCode: string;
  title: string;
  startedAt: Date | null;
  durationMinutes: number;
  participants: number;
  speakers: SpeakerStat[];
  /** 1 = everyone spoke equally, 0 = one person did all the talking; null with fewer than 2 speakers. */
  balance: number | null;
  agenda: { total: number; done: number; skipped: number; completion: number | null };
  goal: string | null;
  decisions: { total: number; agreed: number; open: number; avgMinutesToDecide: number | null };
  tasks: { total: number; done: number; open: number; overdue: number; unowned: number; completion: number | null };
  unresolved: number;
  risks: number;
  topics: string[];
}

interface SpeakerAgg {
  _id: { sessionId: string; speaker: string };
  lines: number;
  words: number;
  ms: number;
  unmeasuredWords: number;
  first: Date;
  last: Date;
}

export function balanceIndex(shares: number[]): number | null {
  const xs = shares.filter((s) => s > 0);
  if (xs.length < 2) return null;
  const h = -xs.reduce((t, p) => t + p * Math.log(p), 0);
  return Math.round((h / Math.log(xs.length)) * 100) / 100;
}

const round = (n: number, d = 1) => Math.round(n * 10 ** d) / 10 ** d;
const avg = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);

export function computeSessionMetrics(s: SessionDoc & { endedAt?: Date }, rows: SpeakerAgg[], today: string): SessionMetrics {
  const ins = s.insights ?? {};
  const speakers = rows.map((r) => ({
    name: r._id.speaker,
    lines: r.lines,
    words: r.words,
    seconds: Math.round(r.ms / 1000 + r.unmeasuredWords / WORDS_PER_SECOND),
  }));
  const talk = speakers.reduce((t, x) => t + x.seconds, 0);
  const withShare: SpeakerStat[] = speakers
    .map((x) => ({ ...x, share: talk ? round(x.seconds / talk, 3) : 0 }))
    .sort((a, b) => b.seconds - a.seconds);

  const firstLine = rows.length ? Math.min(...rows.map((r) => +new Date(r.first))) : null;
  const lastLine = rows.length ? Math.max(...rows.map((r) => +new Date(r.last))) : null;
  const start = s.startedAt ? +new Date(s.startedAt) : firstLine;
  const end = s.endedAt ? +new Date(s.endedAt) : lastLine;
  const durationMinutes = start && end && end > start ? round((end - start) / 60_000) : 0;

  const agenda = (ins.agenda ?? []).filter((a) => a.id !== 'followups');
  const agendaDone = agenda.filter((a) => a.status === 'done').length;
  const decisions = ins.decisions ?? [];
  const decideTimes = decisions
    .filter((d) => d.status === 'agreed' && d.firstSeenAt && d.settledAt)
    .map((d) => (Date.parse(d.settledAt!) - Date.parse(d.firstSeenAt!)) / 60_000)
    .filter((m) => m >= 0);
  const tasks = ins.actionItems ?? [];
  const openDecisions = decisions.filter((d) => d.status === 'disputed' || d.status === 'proposed').length;
  const openQuestions = (ins.openQuestions ?? []).filter((q) => q.status === 'open').length;
  const risks = (ins.risks ?? []).filter((r) => r.status === 'open').length;

  return {
    sessionId: s.sessionId,
    meetingCode: s.meetingCode,
    title: s.title ?? 'Untitled meeting',
    startedAt: s.startedAt ?? null,
    durationMinutes,
    participants: Math.max(withShare.length, (s.participants ?? []).length),
    speakers: withShare,
    balance: balanceIndex(withShare.map((x) => x.share)),
    agenda: {
      total: agenda.length,
      done: agendaDone,
      skipped: agenda.filter((a) => a.status === 'skipped').length,
      completion: agenda.length ? round(agendaDone / agenda.length, 2) : null,
    },
    goal: s.recap?.goalOutcome?.status ?? null,
    decisions: {
      total: decisions.filter((d) => d.status !== 'rejected').length,
      agreed: decisions.filter((d) => d.status === 'agreed').length,
      open: openDecisions,
      avgMinutesToDecide: decideTimes.length ? round(avg(decideTimes)!) : null,
    },
    tasks: {
      total: tasks.length,
      done: tasks.filter((t) => t.status === 'done').length,
      open: tasks.filter((t) => t.status === 'open').length,
      overdue: tasks.filter((t) => t.status === 'open' && !!t.dueDate && t.dueDate < today).length,
      unowned: tasks.filter((t) => !t.owner).length,
      completion: tasks.length ? round(tasks.filter((t) => t.status === 'done').length / tasks.length, 2) : null,
    },
    unresolved: openDecisions + openQuestions + risks,
    risks,
    topics: (ins.topics ?? []).map((t) => t.title),
  };
}

async function speakerRows(sessionIds: string[]): Promise<SpeakerAgg[]> {
  if (!sessionIds.length) return [];
  return TranscriptLineModel.aggregate<SpeakerAgg>([
    { $match: { sessionId: { $in: sessionIds }, isAgent: { $ne: true } } },
    {
      $project: {
        sessionId: 1,
        speakerName: 1,
        at: 1,
        ms: { $ifNull: ['$durationMs', 0] },
        words: { $size: { $split: [{ $trim: { input: { $ifNull: ['$text', ''] } } }, ' '] } },
      },
    },
    {
      $group: {
        _id: { sessionId: '$sessionId', speaker: '$speakerName' },
        lines: { $sum: 1 },
        words: { $sum: '$words' },
        ms: { $sum: '$ms' },
        unmeasuredWords: { $sum: { $cond: [{ $gt: ['$ms', 0] }, 0, '$words'] } },
        first: { $min: '$at' },
        last: { $max: '$at' },
      },
    },
  ]);
}

export async function sessionMetrics(sessions: Array<SessionDoc & { endedAt?: Date }>, now = new Date()): Promise<SessionMetrics[]> {
  const rows = await speakerRows(sessions.map((s) => s.sessionId));
  const by = new Map<string, SpeakerAgg[]>();
  for (const r of rows) by.set(r._id.sessionId, [...(by.get(r._id.sessionId) ?? []), r]);
  const today = now.toISOString().slice(0, 10);
  return sessions.map((s) => computeSessionMetrics(s, by.get(s.sessionId) ?? [], today));
}

const SESSION_FIELDS = {
  sessionId: 1, meetingCode: 1, title: 1, startedAt: 1, endedAt: 1, participants: 1, 'recap.goalOutcome': 1,
  'insights.agenda': 1, 'insights.decisions': 1, 'insights.actionItems': 1, 'insights.openQuestions': 1, 'insights.risks': 1, 'insights.topics': 1,
} as const;

function summarise(ms: SessionMetrics[]) {
  const totalTasks = ms.reduce((t, m) => t + m.tasks.total, 0);
  const doneTasks = ms.reduce((t, m) => t + m.tasks.done, 0);
  const goals = ms.filter((m) => m.goal && m.goal !== 'no_goal');
  const nums = (f: (m: SessionMetrics) => number | null) => ms.map(f).filter((x): x is number => x !== null);
  const r = (x: number | null, d = 1) => (x === null ? null : round(x, d));
  return {
    meetings: ms.length,
    hours: round(ms.reduce((t, m) => t + m.durationMinutes, 0) / 60),
    avgMinutes: r(avg(nums((m) => m.durationMinutes || null))),
    avgParticipants: r(avg(nums((m) => m.participants || null))),
    avgBalance: r(avg(nums((m) => m.balance)), 2),
    agendaCompletion: r(avg(nums((m) => m.agenda.completion)), 2),
    decisionsPerMeeting: r(avg(ms.map((m) => m.decisions.agreed))),
    avgMinutesToDecide: r(avg(nums((m) => m.decisions.avgMinutesToDecide))),
    unresolvedPerMeeting: r(avg(ms.map((m) => m.unresolved))),
    taskCompletion: totalTasks ? round(doneTasks / totalTasks, 2) : null,
    tasks: totalTasks,
    overdueTasks: ms.reduce((t, m) => t + m.tasks.overdue, 0),
    goalMetRate: goals.length ? round(goals.filter((m) => m.goal === 'met').length / goals.length, 2) : null,
    meetingsWithoutOutcome: ms.filter((m) => m.decisions.agreed === 0 && m.tasks.total === 0 && m.durationMinutes > 0).length,
  };
}

export type AnalyticsSummary = ReturnType<typeof summarise>;

const topicKey = (t: string) => t.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, '').replace(/\s+/g, ' ').trim();

/** Over the sessions the user may see. */
export async function analyticsOverview(sessionIds: string[], days: number, now = new Date()) {
  const since = new Date(now.getTime() - days * 86_400_000);
  const before = new Date(since.getTime() - days * 86_400_000);
  const load = (from: Date, to: Date) =>
    MeetingInsightModel.find({ sessionId: { $in: sessionIds }, startedAt: { $gte: from, $lt: to } })
      .sort({ startedAt: -1 })
      .limit(500)
      .select(SESSION_FIELDS)
      .lean() as Promise<Array<SessionDoc & { endedAt?: Date }>>;
  const [current, previous] = await Promise.all([load(since, now), load(before, since)]);
  const [cur, prev] = await Promise.all([sessionMetrics(current, now), sessionMetrics(previous, now)]);

  // Weekly trend.
  const weeks = new Map<string, { week: string; meetings: number; hours: number; decisions: number; tasks: number; tasksDone: number }>();
  for (const m of cur) {
    if (!m.startedAt) continue;
    const d = new Date(m.startedAt);
    d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
    const week = d.toISOString().slice(0, 10);
    const w = weeks.get(week) ?? { week, meetings: 0, hours: 0, decisions: 0, tasks: 0, tasksDone: 0 };
    w.meetings++;
    w.hours = round(w.hours + m.durationMinutes / 60, 2);
    w.decisions += m.decisions.agreed;
    w.tasks += m.tasks.total;
    w.tasksDone += m.tasks.done;
    weeks.set(week, w);
  }

  // Who talks how much, across meetings.
  const people = new Map<string, { name: string; meetings: number; minutes: number; shareSum: number }>();
  for (const m of cur) {
    for (const s of m.speakers) {
      const p = people.get(s.name) ?? { name: s.name, meetings: 0, minutes: 0, shareSum: 0 };
      p.meetings++;
      p.minutes = round(p.minutes + s.seconds / 60);
      p.shareSum += s.share;
      people.set(s.name, p);
    }
  }

  // Subjects that keep coming back (discussed in more than one meeting).
  const topics = new Map<string, { title: string; meetings: Set<string> }>();
  for (const m of cur) {
    for (const t of m.topics) {
      const k = topicKey(t);
      if (!k) continue;
      const x = topics.get(k) ?? { title: t, meetings: new Set<string>() };
      x.meetings.add(m.sessionId);
      topics.set(k, x);
    }
  }

  return {
    days,
    summary: summarise(cur),
    previous: summarise(prev),
    weeks: [...weeks.values()].sort((a, b) => a.week.localeCompare(b.week)),
    people: [...people.values()]
      .map((p) => ({ name: p.name, meetings: p.meetings, minutes: p.minutes, avgShare: round(p.shareSum / p.meetings, 2) }))
      .sort((a, b) => b.minutes - a.minutes)
      .slice(0, 30),
    recurringTopics: [...topics.values()]
      .filter((t) => t.meetings.size > 1)
      .map((t) => ({ title: t.title, meetings: t.meetings.size }))
      .sort((a, b) => b.meetings - a.meetings)
      .slice(0, 15),
    sessions: cur.map(({ speakers, topics: _t, ...rest }) => ({ ...rest, speakers: speakers.slice(0, 8) })),
  };
}

export type AnalyticsOverview = Awaited<ReturnType<typeof analyticsOverview>>;

// ---------- AI recommendations ----------

export const InsightsOutput = z.object({
  insights: z
    .array(
      z.object({
        kind: z.enum(['win', 'issue', 'suggestion']),
        title: z.string().describe('Short headline'),
        detail: z.string().describe('One or two sentences grounded in the numbers, with a concrete action'),
      }),
    )
    .describe('3 to 6 insights, most valuable first'),
});

export const INSIGHTS_SYSTEM = `You are a meeting-effectiveness coach. You get measured statistics about a team's meetings for
a period and the previous period of the same length. Give concrete, actionable insights: what improved, what is
a problem, and what to change (e.g. cancel or shorten meetings that produce no decisions, rebalance who speaks,
time-box agenda items, follow up on overdue tasks, settle recurring topics once). Ground every point in the
numbers given; never invent data. If there is too little data, say so in one insight. Plain text, no markdown.

${UNTRUSTED_RULES}`;

export async function analyticsInsights(ai: AiClient, o: AnalyticsOverview) {
  const payload = {
    periodDays: o.days,
    current: o.summary,
    previous: o.previous,
    weeks: o.weeks,
    people: o.people.slice(0, 12),
    recurringTopics: o.recurringTopics,
    meetings: o.sessions.slice(0, 40).map((s) => ({
      title: s.title, minutes: s.durationMinutes, participants: s.participants, balance: s.balance, agenda: s.agenda.completion,
      decisions: s.decisions.agreed, tasks: s.tasks.total, unresolved: s.unresolved, goal: s.goal,
    })),
  };
  return ai.structured(InsightsOutput, { system: INSIGHTS_SYSTEM, prompt: fence('MEETING STATISTICS (titles and topics are participant content)', JSON.stringify(payload)), temperature: 0.3 });
}
