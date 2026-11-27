import { Schema, model, type InferSchemaType } from 'mongoose';

/**
 * Someone waiting in the lobby of a meeting with the waiting room on. The requester polls
 * with a secret (only its hash is stored) until the host admits or denies them.
 * Requests expire automatically after 15 minutes (TTL index).
 */
const JoinRequestSchema = new Schema(
  {
    requestId: { type: String, required: true, unique: true },
    meetingCode: { type: String, required: true, index: true },
    secretHash: { type: String, required: true },
    identity: { type: String, required: true },
    name: { type: String, required: true },
    userId: { type: String, default: null },
    role: { type: String, enum: ['participant', 'guest'], required: true },
    transcribe: { type: Boolean },
    status: { type: String, enum: ['pending', 'admitted', 'denied', 'joined'], default: 'pending', index: true },
    createdAt: { type: Date, default: Date.now, expires: 15 * 60 },
  },
  { collection: 'join_requests' },
);

export type JoinRequest = InferSchemaType<typeof JoinRequestSchema>;
export const JoinRequestModel = model('JoinRequest', JoinRequestSchema);
