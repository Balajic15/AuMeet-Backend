import { Router } from 'express';
import { z } from 'zod';
import { aiConfigured, getAi } from '../ai/gemini.js';
import { requireAuth } from '../middleware/auth.js';
import { MeetingModel } from '../models/Meeting.js';
import { MeetingInsightModel } from '../models/Insights.js';
import { accessibleMeetingCodes } from '../memory/access.js';
import { ANSWER_SYSTEM, AnswerOutput, answerPrompt, searchMemory } from '../memory/search.js';
import type { SessionDoc } from '../memory/types.js';
import { conflict, forbidden, notFound } from '../utils/httpError.js';
import { buildLedger, renderLedger, type LedgerTask } from '../memory/ledger.js';
import { FollowActionModel, type FollowAction } from '../models/FollowAction.js';
import { publicAction, reportTaskProgress } from '../services/followThrough.js';

const router = Router();
router.use(requireAuth);

/** "My tasks" across all meetings + decisions still waiting for the team. */
router.get('/overview', async (req, res) => {
  const uid = req.auth!.sub;
  const codes = await accessibleMeetingCodes(uid);

  const [withMyTasks, recent] = await Promise.all([
    MeetingInsightModel.find({ 'insights.actionItems.ownerUserId': uid })
      .sort({ startedAt: -1 })
      .limit(100)
      .select({ sessionId: 1, meetingCode: 1, title: 1, startedAt: 1, endedAt: 1, 'insights.actionItems': 1 })
      .lean(),
    MeetingInsightModel.find({ meetingCode: { $in: codes } })
      .sort({ startedAt: -1 })
      .limit(30)
      .select({ sessionId: 1, meetingCode: 1, title: 1, startedAt: 1, 'insights.decisions': 1 })
      .lean(),
  ]);

  const tasks = (withMyTasks as SessionDoc[]).flatMap((s) =>
    (s.insights?.actionItems ?? [])
      .filter((a) => a.ownerUserId === uid)
      .map((a) => ({
        sessionId: s.sessionId,
        meetingCode: s.meetingCode,
        meetingTitle: s.title ?? 'Untitled meeting',
        meetingDate: s.startedAt ?? null,
        editable: !!s.endedAt,
        id: a.id,
        task: a.task,
        deadline: a.deadline,
        dueDate: a.dueDate,
        status: a.status,
      })),
  );
  // Open first, then by due date (undated last), then newest meeting.
  tasks.sort(
    (a, b) =>
      Number(a.status === 'done') - Number(b.status === 'done') ||
      (a.dueDate ?? '9999').localeCompare(b.dueDate ?? '9999') ||
      +new Date(b.meetingDate ?? 0) - +new Date(a.meetingDate ?? 0),
  );

  const openDecisions = (recent as SessionDoc[]).flatMap((s) =>
    (s.insights?.decisions ?? [])
      .filter((d) => d.status === 'disputed' || (d.status === 'proposed' && d.confirmationNeeded))
      .map((d) => ({
        sessionId: s.sessionId,
        meetingCode: s.meetingCode,
        meetingTitle: s.title ?? 'Untitled meeting',
        meetingDate: s.startedAt ?? null,
        id: d.id,
        statement: d.statement,
        status: d.status,
        options: d.options ?? [],
        confirmationNeeded: d.confirmationNeeded ?? null,
      })),
  ).slice(0, 20);

  res.json({ tasks, openDecisions, askEnabled: aiConfigured() });
});

const TaskUpdate = z.object({ status: z.enum(['open', 'done']) });

/** Tick a task off (owner or meeting host). Only after the session ended – the live note-taker owns it until then. */
router.patch('/tasks/:sessionId/:taskId', async (req, res) => {
  const uid = req.auth!.sub;
  const { status } = TaskUpdate.parse(req.body);
  const sessionId = String(req.params.sessionId);
  const taskId = String(req.params.taskId);

  const session = (await MeetingInsightModel.findOne({ sessionId }).lean()) as SessionDoc | null;
  const task = session?.insights?.actionItems?.find((a) => a.id === taskId);
  if (!session || !task) throw notFound('Task not found');

  const meeting = await MeetingModel.findOne({ code: session.meetingCode }).select({ host: 1 }).lean();
  const isHost = meeting?.host?.toString() === uid;
  if (task.ownerUserId !== uid && !isHost) throw forbidden('Only the task owner or the meeting host can update it');
  if (!session.endedAt) throw conflict('This meeting is still in progress');

  await MeetingInsightModel.updateOne(
    { sessionId },
    { $set: { 'insights.actionItems.$[t].status': status, 'insights.actionItems.$[t].updatedAt': new Date().toISOString() } },
    { arrayFilters: [{ 't.id': taskId }] },
  );
  if (status !== task.status) void reportTaskProgress(session.meetingCode, sessionId, task, status);
  res.json({ ok: true, status });
});

/**
 * Team commitments across every meeting I can see: open work by owner (overdue first), recently
 * completed work, and open risks. "Who owns what, and what is still pending?"
 */
router.get('/commitments', async (req, res) => {
  const codes = await accessibleMeetingCodes(req.auth!.sub);
  const ledger = await buildLedger(codes);
  const open = ledger.tasks.filter((t) => t.status === 'open');
  const byOwner = new Map<string, LedgerTask[]>();
  for (const t of open) {
    const k = t.owner ?? '';
    byOwner.set(k, [...(byOwner.get(k) ?? []), t]);
  }
  const owners = [...byOwner.entries()]
    .map(([owner, tasks]) => ({
      owner: owner || null,
      open: tasks.length,
      overdue: tasks.filter((t) => t.overdue).length,
      tasks: tasks.sort((a, b) => Number(b.overdue) - Number(a.overdue) || (a.dueDate ?? '9999').localeCompare(b.dueDate ?? '9999')),
    }))
    .sort((a, b) => Number(!a.owner) - Number(!b.owner) || b.overdue - a.overdue || b.open - a.open);
  const done = ledger.tasks.filter((t) => t.status === 'done').length;
  res.json({
    owners,
    totals: { open: open.length, overdue: open.filter((t) => t.overdue).length, done, unowned: open.filter((t) => !t.owner).length },
    risks: ledger.risks.slice(0, 30),
  });
});

/** Follow-up actions from my meetings that are waiting for my approval. */
router.get('/follow-through', async (req, res) => {
  const actions = await FollowActionModel.find({ hostId: req.auth!.sub, status: 'proposed' }).sort({ createdAt: -1 }).limit(50).lean();
  const titles = new Map(
    (await MeetingInsightModel.find({ sessionId: { $in: [...new Set(actions.map((a) => a.sessionId))] } }).select({ sessionId: 1, title: 1 }).lean()).map(
      (s) => [s.sessionId, s.title ?? 'Untitled meeting'],
    ),
  );
  res.json({ actions: actions.map((a) => ({ ...publicAction(a as FollowAction), meetingTitle: titles.get(a.sessionId) ?? 'Meeting' })) });
});

const AskBody = z.object({ question: z.string().trim().min(3).max(500) });

/** "What did we decide about the database?" – answered from the user's own meetings. */
router.post('/ask', async (req, res) => {
  const { question } = AskBody.parse(req.body);
  const ai = getAi(); // 503 if not configured
  const codes = await accessibleMeetingCodes(req.auth!.sub);
  const [hits, ledger] = await Promise.all([searchMemory(ai, codes, question, 8), buildLedger(codes)]);
  const ledgerText = renderLedger(ledger);

  if (hits.length === 0 && !ledgerText) {
    res.json({ answer: "I couldn't find anything about that in your meetings.", sources: [] });
    return;
  }

  const out = await ai.structured(AnswerOutput, { system: ANSWER_SYSTEM, prompt: answerPrompt(question, hits, ledgerText), temperature: 0.2 });
  const used = [...new Set(out.sources)].filter((n) => n >= 1 && n <= hits.length).map((n) => hits[n - 1]!);
  res.json({
    answer: out.answer.trim(),
    sources: used.map((h) => ({
      meetingCode: h.meetingCode,
      sessionId: h.sessionId,
      meetingTitle: h.title,
      meetingDate: h.startedAt,
      kind: h.kind,
      excerpt: h.text.length > 400 ? `${h.text.slice(0, 400)}…` : h.text,
    })),
  });
});

export default router;
