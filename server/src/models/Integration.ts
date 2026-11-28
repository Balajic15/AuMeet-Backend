import { Schema, model, type InferSchemaType } from 'mongoose';

/*
 * A user's connection to an outside service the follow-through agent acts in:
 *   google – Gmail (send follow-up emails as the user) and Google Calendar (create events, invite attendees)
 *   jira / linear / asana – create issues for meeting tasks and close them when the task is done
 * Credentials are encrypted (services/secrets.ts) and never leave the server.
 */

export const INTEGRATION_PROVIDERS = ['google', 'jira', 'linear', 'asana'] as const;
export type IntegrationProvider = (typeof INTEGRATION_PROVIDERS)[number];

const IntegrationSchema = new Schema(
  {
    userId: { type: String, required: true },
    provider: { type: String, enum: INTEGRATION_PROVIDERS, required: true },
    status: { type: String, enum: ['connected', 'error'], default: 'connected' },
    /** Who it is connected as (email / user name), for display. */
    account: { type: String, default: '' },
    /** Non-secret settings: Jira site + project, Linear team, Asana workspace + project, Google scopes. */
    config: { type: Schema.Types.Mixed, default: {} },
    /** Encrypted credentials. */
    secret: { type: String, required: true, select: false },
    /** Use this connection for follow-up actions. */
    enabled: { type: Boolean, default: true },
    lastError: String,
    lastUsedAt: Date,
  },
  { collection: 'integrations', timestamps: true },
);
IntegrationSchema.index({ userId: 1, provider: 1 }, { unique: true });

export type Integration = InferSchemaType<typeof IntegrationSchema>;
export const IntegrationModel = model('Integration', IntegrationSchema);
