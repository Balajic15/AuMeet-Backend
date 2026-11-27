import { Schema, model, Types, type HydratedDocument, type InferSchemaType } from 'mongoose';

// idle  – created, nobody currently in the LiveKit room (can be joined)
// live  – at least one participant connected (driven by LiveKit webhooks)
// ended – host ended the meeting; it can no longer be joined
export const MEETING_STATUSES = ['idle', 'live', 'ended'] as const;

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
      // Host locked the meeting: nobody new can join (the host still can).
      locked: { type: Boolean, default: false },
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
      locked: m.settings?.locked ?? false,
    },
    scheduledFor: m.scheduledFor ?? null,
    startedAt: m.startedAt ?? null,
    endedAt: m.endedAt ?? null,
    createdAt: m.createdAt,
  };
}
