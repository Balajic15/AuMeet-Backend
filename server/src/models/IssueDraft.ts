import { Schema, model, type InferSchemaType } from 'mongoose';

/*
 * A Jira issue the AI is preparing from the conversation (agent/src/jira/flow.ts writes drafts; the server creates
 * them in Jira). It stays a draft until a participant approves it; creation is idempotent (one draft → at most one
 * Jira issue). Attachments live in `issue_attachments` until they are uploaded to Jira.
 */

export const ISSUE_STATUSES = ['drafting', 'ready', 'creating', 'created', 'cancelled', 'failed'] as const;

const AttachmentRef = new Schema(
  {
    id: { type: String, required: true },
    kind: { type: String, enum: ['screenshot', 'recording', 'file'], required: true },
    name: { type: String, required: true },
    mime: { type: String, required: true },
    size: { type: Number, default: 0 },
    /** pending = recording still running/processing; ready = can be uploaded; uploaded = attached in Jira. */
    status: { type: String, enum: ['pending', 'ready', 'uploaded', 'failed'], default: 'ready' },
    recordingId: String,
    addedBy: String,
    at: { type: Date, default: Date.now },
  },
  { _id: false },
);

const IssueDraftSchema = new Schema(
  {
    meetingCode: { type: String, required: true, index: true },
    sessionId: { type: String, required: true, index: true },
    hostId: { type: String, required: true },
    requestedBy: { identity: String, name: String, userId: String },
    type: { type: String, enum: ['bug', 'story', 'task'], required: true },
    status: { type: String, enum: ISSUE_STATUSES, default: 'drafting' },
    fields: { type: Schema.Types.Mixed, default: {} },
    /** Mandatory information still missing (as judged by the AI; the server re-checks the essentials). */
    missing: { type: [String], default: [] },
    evidence: {
      decision: { type: String, enum: ['undecided', 'none', 'later', 'collecting', 'collected'], default: 'undecided' },
      attachments: { type: [AttachmentRef], default: [] },
    },
    /** A likely duplicate the participants were told about. */
    duplicateOf: { key: String, url: String, summary: String },
    jira: { key: String, id: String, url: String },
    error: String,
    approvedBy: String,
  },
  { collection: 'issue_drafts', timestamps: true },
);

export type IssueDraft = InferSchemaType<typeof IssueDraftSchema> & { _id: unknown };
export const IssueDraftModel = model('IssueDraft', IssueDraftSchema);

/** Binary evidence until it is uploaded (Mongo documents are limited to 16 MB; we cap well below). */
const IssueAttachmentSchema = new Schema(
  {
    _id: { type: String },
    draftId: { type: String, required: true, index: true },
    meetingCode: { type: String, required: true },
    name: String,
    mime: String,
    size: Number,
    data: Buffer,
  },
  { collection: 'issue_attachments', timestamps: true },
);
export const IssueAttachmentModel = model('IssueAttachment', IssueAttachmentSchema);

/** Largest attachment kept or uploaded. */
export const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;
