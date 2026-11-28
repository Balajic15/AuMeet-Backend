import { Router } from 'express';
import mongoose from 'mongoose';
import { z } from 'zod';
import { requireAuth } from '../middleware/auth.js';
import { UserModel } from '../models/User.js';
import { BehaviourOverride, defaultBehaviour, mergeLayers, resolve, Behaviour } from '../services/aiBehaviour.js';
import { badRequest, notFound } from '../utils/httpError.js';
import { aiConfigured, getAi } from '../ai/gemini.js';
import {
  corrections,
  feedbackStats,
  LearningPolicy,
  learningPolicy,
  learnLessons,
  lessonsCol,
  lessonsView,
  recheckLessons,
  rollbackLessons,
  setCorrectionExcluded,
  toggleLesson,
} from '../services/feedback.js';
import { assertSafeWebhook, FollowThroughSettings, followThroughSettings } from '../services/followThrough.js';
import { mailConfigured } from '../services/mailer.js';

/** The signed-in user's default AI behaviour and what the AI learned from their meetings. */
const router = Router();
router.use(requireAuth);

async function accountView(userId: string) {
  const user = await UserModel.findById(userId).select({ aiBehaviour: 1 }).lean();
  if (!user) throw notFound('User not found');
  const defaults = await defaultBehaviour();
  const account = ((user as { aiBehaviour?: unknown }).aiBehaviour ?? {}) as BehaviourOverride;
  return { defaults, account, effective: resolve(defaults, account) };
}

router.get('/behaviour', async (req, res) => {
  res.json(await accountView(req.auth!.sub));
});

// Replace (account: {...}) or reset (account: null) my default.
router.put('/behaviour', async (req, res) => {
  const { account } = z.object({ account: BehaviourOverride.nullable() }).parse(req.body ?? {});
  if (account) {
    const check = Behaviour.safeParse(mergeLayers(await defaultBehaviour(), account));
    if (!check.success) throw badRequest('These settings are not valid together');
  }
  await UserModel.updateOne({ _id: req.auth!.sub }, account ? { $set: { aiBehaviour: account } } : { $unset: { aiBehaviour: 1 } });
  res.json(await accountView(req.auth!.sub));
});

const reactions = () => mongoose.connection.collection('ai_reactions');

// How people reacted to the AI speaking up in my meetings, by what it was trying to do.
router.get('/learning', async (req, res) => {
  const rows = await reactions()
    .aggregate<{ _id: { intent: string; reaction: string }; n: number }>([
      { $match: { hostId: req.auth!.sub } },
      { $group: { _id: { intent: '$intent', reaction: '$reaction' }, n: { $sum: 1 } } },
    ])
    .toArray();
  const by = new Map<string, { intent: string; engaged: number; ignored: number; rejected: number }>();
  for (const r of rows) {
    const s = by.get(r._id.intent) ?? { intent: r._id.intent, engaged: 0, ignored: 0, rejected: 0 };
    if (r._id.reaction === 'engaged' || r._id.reaction === 'ignored' || r._id.reaction === 'rejected') s[r._id.reaction] += r.n;
    by.set(r._id.intent, s);
  }
  const stats = [...by.values()].sort((a, b) => b.engaged + b.ignored + b.rejected - (a.engaged + a.ignored + a.rejected));
  res.json({ stats, total: stats.reduce((t, s) => t + s.engaged + s.ignored + s.rejected, 0) });
});

router.delete('/learning', async (req, res) => {
  const { deletedCount } = await reactions().deleteMany({ hostId: req.auth!.sub });
  res.json({ deleted: deletedCount });
});

// ---------- follow-through agent settings ----------

router.get('/follow-through', async (req, res) => {
  res.json({ settings: await followThroughSettings(req.auth!.sub), mail: mailConfigured() });
});

router.put('/follow-through', async (req, res) => {
  const patch = FollowThroughSettings.partial().strict().parse(req.body ?? {});
  if (patch.webhookUrl) {
    try {
      await assertSafeWebhook(patch.webhookUrl);
    } catch (err) {
      throw badRequest((err as Error).message || 'This webhook address cannot be used');
    }
  }
  const next = { ...(await followThroughSettings(req.auth!.sub)), ...patch };
  await UserModel.updateOne({ _id: req.auth!.sub }, { $set: { followThrough: next } });
  res.json({ settings: next, mail: mailConfigured() });
});

// ---------- learning from corrections (self-improving notes) ----------

async function feedbackView(hostId: string) {
  const [stats, view] = await Promise.all([feedbackStats(hostId), lessonsView(hostId)]);
  return { ...stats, ...view, canLearn: aiConfigured() };
}

/** Service errors carry a status (404 for an unknown version / lesson / correction). */
async function guarded<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if ((err as { status?: number }).status === 404) throw notFound((err as Error).message);
    throw err;
  }
}

// Corrections made to the notes of my meetings, recurring mistakes, current lessons (applied and waiting),
// their evidence, the learning policy, and the version history.
router.get('/feedback', async (req, res) => {
  res.json(await feedbackView(req.auth!.sub));
});

// Re-learn now instead of waiting for the worker.
router.post('/feedback/learn', async (req, res) => {
  const ai = getAi();
  await learnLessons(req.auth!.sub, ai, new Date(), req.auth!.sub);
  res.json(await feedbackView(req.auth!.sub));
});

// Go back to an earlier version of the lessons.
router.post('/feedback/rollback', async (req, res) => {
  const { version } = z.object({ version: z.number().int().positive() }).parse(req.body);
  await guarded(() => rollbackLessons(req.auth!.sub, version, req.auth!.sub));
  res.json(await feedbackView(req.auth!.sub));
});

// Switch a lesson off (never applied or proposed again) or back on (re-checked against the policy).
router.patch('/feedback/lessons/:id', async (req, res) => {
  const { active } = z.object({ active: z.boolean() }).parse(req.body);
  await guarded(() => toggleLesson(req.auth!.sub, String(req.params.id), active, req.auth!.sub));
  res.json(await feedbackView(req.auth!.sub));
});

// "This correction was wrong": it stops counting as evidence right away.
router.patch('/feedback/corrections/:id', async (req, res) => {
  const { excluded } = z.object({ excluded: z.boolean() }).parse(req.body);
  await guarded(() => setCorrectionExcluded(req.auth!.sub, String(req.params.id), excluded, req.auth!.sub));
  res.json(await feedbackView(req.auth!.sub));
});

// My overrides of the learning thresholds (stricter or looser than the system policy).
router.put('/feedback/policy', async (req, res) => {
  const patch = LearningPolicy.partial().strict().parse(req.body ?? {});
  const hostId = req.auth!.sub;
  const { host } = await learningPolicy(hostId);
  const next = { ...host, ...patch };
  await lessonsCol().updateOne(
    { _id: hostId },
    { $set: { policy: next }, $setOnInsert: { current: 0, versions: [], disabled: [], updatedAt: new Date(0) } },
    { upsert: true },
  );
  // New thresholds apply to the current lessons right away.
  await recheckLessons(hostId, hostId);
  res.json(await feedbackView(hostId));
});

// The evaluation dataset: one JSON object per correction (what the AI wrote, the fix, the transcript it used).
router.get('/feedback/dataset', async (req, res) => {
  const rows = await corrections()
    .find({ hostId: req.auth!.sub })
    .sort({ at: -1 })
    .limit(5000)
    .project({ _id: 0, hostId: 0, by: 0 })
    .toArray();
  res.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="aumeet-corrections.jsonl"');
  res.send(rows.map((r) => JSON.stringify(r)).join('\n') + (rows.length ? '\n' : ''));
});

router.delete('/feedback', async (req, res) => {
  const hostId = req.auth!.sub;
  const [{ deletedCount }] = await Promise.all([corrections().deleteMany({ hostId }), lessonsCol().deleteOne({ _id: hostId })]);
  res.json({ deleted: deletedCount });
});

export default router;
