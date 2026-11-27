import { Schema, model, Types, type HydratedDocument, type InferSchemaType } from 'mongoose';

// idle  – created, nobody currently in the LiveKit room (can be joined)
// live  – at least one participant connected (driven by LiveKit webhooks)
// ended – host ended the meeting; it can no longer be joined
export const MEETING_STATUSES = ['idle', 'live', 'ended'] as const;

/** How readily the AI answers: only when addressed by name, or any question asked in the room. */
export const AI_REPLY_MODES = ['named', 'any'] as const;
export type AiReplyMode = (typeof AI_REPLY_MODES)[number];

const ParticipantSchema = new Schema(
  {
    // LiveKit identity – `user:<id>` for accounts, `guest:<id>` for guests.
    identity: { type: String, required: true },
    name: { type: String, required: true },
    user: { type: Types.ObjectId, ref: 'User' },
    role: { type: String, enum: ['host', 'participant', 'guest'], required: true },
    firstJoinedAt: { type: Date, default: Date.now },
    lastJoinedAt: { type: Date, default: Date.now },
  },
  { _id: false },
);

const AgendaItemSchema = new Schema(
  {
    id: { type: String, required: true },
    title: { type: String, required: true, trim: true, maxlength: 200 },
    /** Planned time box in minutes (optional). */
    minutes: { type: Number, min: 1, max: 600 },
  },
  { _id: false },
);

const MeetingSchema = new Schema(
  {
    // Human-friendly room code used in invite links, e.g. `abc-defg-hij`.
    // Also used as the LiveKit room name.
    code: { type: String, required: true, unique: true },
    title: { type: String, required: true, trim: true, maxlength: 120 },
    host: { type: Types.ObjectId, ref: 'User', required: true, index: true },
    status: { type: String, enum: MEETING_STATUSES, default: 'idle' },
    settings: {
      allowGuests: { type: Boolean, default: true },
      aiEnabled: { type: Boolean, default: true },
      // AI may speak up on its own (confirm decisions, ask for owners). Off = only when asked.
      aiProactive: { type: Boolean, default: true },
      aiReplyMode: { type: String, enum: AI_REPLY_MODES, default: 'named' },
      // AI facilitates: opens the meeting, announces agenda transitions, wraps up.
      aiFacilitator: { type: Boolean, default: false },
      // Email the recap (and each person's tasks) to participants after the meeting.
      followUpEmail: { type: Boolean, default: true },
      // Host locked the meeting: nobody new can join (the host still can).
      locked: { type: Boolean, default: false },
      // People wait in the lobby until the host admits them.
      waitingRoom: { type: Boolean, default: false },
    },
    // Optional preparation the AI uses to keep the meeting on track.
    prep: {
      goal: { type: String, trim: true, maxlength: 1000 },
      agenda: { type: [AgendaItemSchema], default: [] },
      // Code of an earlier meeting (same host) whose open items carry over into this one.
      followUpOf: { type: String },
    },
    scheduledFor: { type: Date },
    startedAt: { type: Date },
    endedAt: { type: Date },
    participants: { type: [ParticipantSchema], default: [] },
  },
  { timestamps: true },
);

MeetingSchema.index({ 'participants.user': 1 });

export type Meeting = InferSchemaType<typeof MeetingSchema>;
export type MeetingDoc = HydratedDocument<Meeting>;

export const MeetingModel = model('Meeting', MeetingSchema);

export function toPublicMeeting(m: MeetingDoc) {
  return {
    id: m.id as string,
    code: m.code,
    title: m.title,
    hostId: m.host.toString(),
    status: m.status,
    settings: {
      allowGuests: m.settings?.allowGuests ?? true,
      aiEnabled: m.settings?.aiEnabled ?? true,
      aiProactive: m.settings?.aiProactive ?? true,
      aiReplyMode: (m.settings?.aiReplyMode ?? 'named') as AiReplyMode,
      aiFacilitator: m.settings?.aiFacilitator ?? false,
      followUpEmail: m.settings?.followUpEmail ?? true,
      locked: m.settings?.locked ?? false,
      waitingRoom: m.settings?.waitingRoom ?? false,
    },
    prep: {
      goal: m.prep?.goal ?? '',
      agenda: (m.prep?.agenda ?? []).map((a) => ({ id: a.id, title: a.title, minutes: a.minutes ?? null })),
      followUpOf: m.prep?.followUpOf ?? null,
    },
    scheduledFor: m.scheduledFor ?? null,
    startedAt: m.startedAt ?? null,
    endedAt: m.endedAt ?? null,
    createdAt: m.createdAt,
  };
}
