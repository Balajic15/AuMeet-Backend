import { Router } from 'express';
import { z } from 'zod';
import { aiConfigured, getAi } from '../ai/gemini.js';
import { requireAuth } from '../middleware/auth.js';
import { MeetingInsightModel } from '../models/Insights.js';
import { accessibleSessionIds } from '../memory/access.js';
import type { SessionDoc } from '../memory/types.js';
import { analyticsInsights, analyticsOverview, sessionMetrics } from '../services/analytics.js';
import { notFound } from '../utils/httpError.js';

/** Meeting effectiveness over the meetings the user may see (same access rule as notes and Ask). */
const router = Router();
router.use(requireAuth);

const Period = z.object({ days: z.coerce.number().int().min(1).max(365).default(30) });

router.get('/', async (req, res) => {
  const { days } = Period.parse(req.query);
  const ids = await accessibleSessionIds(req.auth!.sub);
  res.json({ ...(await analyticsOverview(ids, days)), aiEnabled: aiConfigured() });
});

// Recommendations written by the model from the measured numbers.
router.post('/insights', async (req, res) => {
  const { days } = Period.parse(req.body ?? {});
  const ai = getAi();
  const ids = await accessibleSessionIds(req.auth!.sub);
  const overview = await analyticsOverview(ids, days);
  if (overview.summary.meetings === 0) {
    res.json({ insights: [] });
    return;
  }
  res.json(await analyticsInsights(ai, overview));
});

router.get('/sessions/:sessionId', async (req, res) => {
  const ids = await accessibleSessionIds(req.auth!.sub);
  const sid = String(req.params.sessionId);
  const session = (ids.includes(sid) ? await MeetingInsightModel.findOne({ sessionId: sid }).lean() : null) as
    | (SessionDoc & { endedAt?: Date })
    | null;
  if (!session) throw notFound('Session not found');
  const [metrics] = await sessionMetrics([session]);
  res.json({ metrics });
});

export default router;
