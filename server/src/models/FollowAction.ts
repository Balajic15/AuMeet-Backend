import { Schema, model, type InferSchemaType } from 'mongoose';

/*
 * Something the follow-through agent wants to do after a meeting: email a task owner, remind someone
 * of a deadline, put a follow-up meeting or deadline in people's calendars, or push a task to the
 * team's project tool. External actions wait for the host's approval; the host can edit them first.
 */

export const ACTION_KINDS = ['email', 'reminder', 'calendar', 'task_sync'] as const;
export const ACTION_STATUSES = ['proposed', 'approved', 'done', 'dismissed', 'failed'] as const;

const Recipient = new Schema(
  { userId: String, name: String, email: String },
  { _id: false },
);

const FollowActionSchema = new Schema(
  {
    sessionId: { type: String, required: true, index: true },
    meetingCode: { type: String, required: true },
    hostId: { type: String, required: true, index: true },
    kind: { type: String, enum: ACTION_KINDS, required: true },
    status: { type: String, enum: ACTION_STATUSES, required: true, default: 'proposed' },
    /** False only for low-risk internal actions the host allowed to run on their own. */
    needsApproval: { type: Boolean, default: true },
    /** Task in the session's notes this is about (reminders, task sync). */
    taskId: String,
    recipients: { type: [Recipient], default: [] },
    title: { type: String, required: true },
    body: { type: String, default: '' },
    /** Reminder time / calendar event start. */
    when: Date,
    durationMinutes: Number,
    /** Why the agent proposes it (shown to the host). */
    reason: { type: String, default: '' },
    /** Dedupes automatic actions, e.g. "overdue:<session>:<task>". */
    dedupeKey: { type: String, index: { unique: true, sparse: true } },
    /** How it was (or will be) carried out: gmail, smtp, google_calendar, ics, jira, linear, asana, webhook. */
    channel: String,
    /** Execution attempts so far, and when the next retry is due after a temporary failure. */
    attempts: { type: Number, default: 0 },
    nextAttemptAt: Date,
    /** Recipients already reached (user ids): a retry never emails someone twice. */
    sentTo: { type: [String], default: [] },
    /** Issue created in the project tool (idempotency + later status updates). */
    external: { type: Schema.Types.Mixed },
    decidedBy: String,
    decidedAt: Date,
    executedAt: Date,
    result: String,
    error: String,
  },
  { collection: 'follow_actions', timestamps: true },
);
FollowActionSchema.index({ status: 1, when: 1 });

export type FollowAction = InferSchemaType<typeof FollowActionSchema> & { _id: unknown };
export const FollowActionModel = model('FollowAction', FollowActionSchema);
