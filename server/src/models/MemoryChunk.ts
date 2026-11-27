import { Schema, model, type InferSchemaType } from 'mongoose';

export const CHUNK_KINDS = ['recap', 'decision', 'task', 'transcript'] as const;

/**
 * A searchable piece of a past meeting with its embedding. Built by the worker
 * (memory/process.ts) after a session ends; read by "Ask your meetings" and the agent.
 *
 * Search is done in the app (cosine over the user's accessible meetings), which is fine
 * for thousands of chunks per user. For larger deployments, add an Atlas Vector Search
 * index on `embedding` and switch memory/search.ts to `$vectorSearch`.
 */
const MemoryChunkSchema = new Schema(
  {
    meetingCode: { type: String, required: true, index: true },
    sessionId: { type: String, required: true, index: true },
    title: { type: String, required: true },
    startedAt: { type: Date },
    kind: { type: String, enum: CHUNK_KINDS, required: true },
    /** Id of the decision/task this chunk describes, or the first transcript line. */
    ref: { type: String },
    text: { type: String, required: true },
    embedding: { type: [Number], required: true },
  },
  { collection: 'memory_chunks', timestamps: true },
);

export type MemoryChunk = InferSchemaType<typeof MemoryChunkSchema>;
export const MemoryChunkModel = model('MemoryChunk', MemoryChunkSchema);
