import { Schema, model, type InferSchemaType } from 'mongoose';

/**
 * A document attached to a meeting before it starts (spec, agenda notes, slides…).
 * Only the extracted text is kept – the original file is discarded after upload.
 * Its searchable pieces live in `memory_chunks` (kind "document", ref = this id).
 */
const MeetingDocumentSchema = new Schema(
  {
    meetingCode: { type: String, required: true, index: true },
    uploadedBy: { type: String, required: true },
    filename: { type: String, required: true, maxlength: 200 },
    mimeType: { type: String, required: true },
    sizeBytes: { type: Number, required: true },
    pages: { type: Number },
    /** Extracted plain text (capped). */
    text: { type: String, required: true },
    chars: { type: Number, required: true },
    /** True when the text was cut to the cap. */
    truncated: { type: Boolean, default: false },
    /** Searchable chunks were embedded (needs GOOGLE_API_KEY). */
    indexed: { type: Boolean, default: false },
  },
  { collection: 'meeting_documents', timestamps: true },
);

export type MeetingDocumentRecord = InferSchemaType<typeof MeetingDocumentSchema>;
export const MeetingDocumentModel = model('MeetingDocument', MeetingDocumentSchema);
