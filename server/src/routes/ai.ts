import { Router } from 'express';
import mongoose from 'mongoose';
import { z } from 'zod';
import { requireAuth } from '../middleware/auth.js';
import { UserModel } from '../models/User.js';
import { BehaviourOverride, defaultBehaviour, mergeLayers, resolve, Behaviour } from '../services/aiBehaviour.js';
import { badRequest, notFound } from '../utils/httpError.js';

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

export default router;
