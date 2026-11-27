import express, { Router } from 'express';
import { WebhookReceiver } from 'livekit-server-sdk';
import { MeetingModel } from '../models/Meeting.js';
import { applyEgressInfo } from '../services/recording.js';
import { env } from '../config/env.js';
import { unauthorized } from '../utils/httpError.js';

/**
 * LiveKit Cloud → Settings → Webhooks → point to `<public-server-url>/api/livekit/webhook`.
 * Keeps meeting status in sync with whether anyone is actually in the room.
 */
const router = Router();
const receiver = new WebhookReceiver(env.LIVEKIT_API_KEY, env.LIVEKIT_API_SECRET);

// LiveKit signs the raw body, so this route must not go through express.json().
router.post('/', express.raw({ type: '*/*' }), async (req, res) => {
  let event;
  try {
    event = await receiver.receive((req.body as Buffer).toString('utf8'), req.get('Authorization'));
  } catch {
    throw unauthorized('Invalid webhook signature');
  }

  if ((event.event === 'egress_ended' || event.event === 'egress_updated') && event.egressInfo) {
    await applyEgressInfo(event.egressInfo);
  }

  const roomName = event.room?.name;
  if (roomName) {
    if (event.event === 'room_started') {
      await MeetingModel.updateOne(
        { code: roomName, status: { $ne: 'ended' } },
        { $set: { status: 'live' }, $min: { startedAt: new Date() } },
      );
    } else if (event.event === 'room_finished') {
      // Room emptied out; the link stays joinable unless the host explicitly ended it.
      await MeetingModel.updateOne({ code: roomName, status: 'live' }, { $set: { status: 'idle' } });
    }
  }

  res.sendStatus(200);
});

export default router;
