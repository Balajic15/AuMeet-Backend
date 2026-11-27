import { Schema, model } from 'mongoose';

/*
 * Written by the AI agent (agent/src/intel/store.ts, agent/src/transcript.ts).
 * The server only reads them, so the schemas are permissive (`strict: false`).
 */

const MeetingInsightSchema = new Schema(
  {
    sessionId: { type: String, required: true },
    meetingCode: { type: String, required: true },
    title: String,
    insights: Schema.Types.Mixed,
    participants: Schema.Types.Mixed,
    participantUserIds: [String],
    startedAt: Date,
    updatedAt: Date,
    endedAt: Date,
    // ----- written by the server's background worker -----
    recap: Schema.Types.Mixed,
    memoryIndexedAt: Date,
    memoryAttempts: Number,
    memoryError: String,
    // Recap email sent to attendees (once per session, even if the notes are edited later).
    followUpSentAt: Date,
    // People can correct the AI notes after the meeting; this triggers a fresh recap + index.
    notesEditedAt: Date,
    notesEditedBy: String,
  },
  { collection: 'meeting_insights', strict: false, timestamps: false, autoIndex: false },
);

export const MeetingInsightModel = model('MeetingInsight', MeetingInsightSchema);

const TranscriptLineSchema = new Schema(
  {
    meetingCode: String,
    sessionId: String,
    seq: Number,
    speakerId: String,
    speakerName: String,
    // Declared so queries on it aren't silently dropped by strictQuery (account deletion filters by it).
    userId: String,
    isAgent: Boolean,
    channel: String,
    text: String,
    language: String,
    at: Date,
  },
  { collection: 'transcripts', strict: false, timestamps: false, autoIndex: false },
);

export const TranscriptLineModel = model('TranscriptLine', TranscriptLineSchema);
