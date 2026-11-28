import { Schema, model, type HydratedDocument, type InferSchemaType } from 'mongoose';

/** A meeting recording made by LiveKit Egress into S3-compatible storage. */
const RecordingSchema = new Schema(
  {
    meetingCode: { type: String, required: true, index: true },
    egressId: { type: String, required: true, unique: true },
    startedBy: { type: String, required: true },
    status: { type: String, enum: ['active', 'complete', 'failed'], default: 'active', index: true },
    /** Object key in the bucket. */
    fileKey: { type: String, required: true },
    durationSec: { type: Number },
    sizeBytes: { type: Number },
    error: { type: String },
    startedAt: { type: Date, default: Date.now },
    endedAt: { type: Date },
    stopRequestedAt: { type: Date },
    /** room = the whole meeting; screen = one shared screen recorded as evidence for a Jira draft. */
    kind: { type: String, enum: ['room', 'screen'], default: 'room' },
    draftId: { type: String, index: { sparse: true } },
  },
  { collection: 'recordings' },
);

export type Recording = InferSchemaType<typeof RecordingSchema>;
export type RecordingDoc = HydratedDocument<Recording>;
export const RecordingModel = model('Recording', RecordingSchema);
