import 'dotenv/config';
import { z } from 'zod';

const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(4000),
  // Reverse proxies in front of the API (nginx = 1; Caddy + nginx = 2). Needed for real client IPs.
  TRUST_PROXY: z.coerce.number().int().min(0).max(5).default(1),
  CORS_ORIGINS: z.string().default('http://localhost:4200'),
  MONGODB_URI: z.string().min(1, 'MONGODB_URI is required'),
  JWT_SECRET: z.string().min(16, 'JWT_SECRET must be at least 16 characters'),
  JWT_EXPIRES_IN: z.string().default('7d'),
  LIVEKIT_URL: z.string().min(1, 'LIVEKIT_URL is required'),
  LIVEKIT_API_KEY: z.string().min(1, 'LIVEKIT_API_KEY is required'),
  LIVEKIT_API_SECRET: z.string().min(1, 'LIVEKIT_API_SECRET is required'),
  // Background jobs (meeting recaps + memory indexing). Required by `npm run worker`.
  REDIS_URL: z.string().optional(),
  // How often the worker looks for finished meetings to recap (fewer Redis commands = cheaper).
  MEMORY_SWEEP_SECONDS: z.coerce.number().int().min(30).default(300),
  // Follow-through agent: how often due reminders and overdue tasks are checked.
  FOLLOW_THROUGH_SWEEP_SECONDS: z.coerce.number().int().min(60).default(900),
  // How often corrections to the AI notes are turned into lessons for the note-taker.
  LEARN_SWEEP_SECONDS: z.coerce.number().int().min(300).default(3600),
  // Gemini – used by the worker (recaps, embeddings) and by "Ask your meetings".
  GOOGLE_API_KEY: z.string().optional(),
  // Fast models first (recaps, "Ask your meetings"); fallbacks when overloaded, over quota or slow.
  GEMINI_MODEL: z.string().default('gemini-3.5-flash-lite'),
  GEMINI_FALLBACK_MODELS: z.string().default('gemini-3-flash-preview,gemini-3.1-flash-lite'),
  GEMINI_THINKING: z.enum(['minimal', 'low', 'off']).default('minimal'),
  EMBEDDING_MODEL: z.string().default('gemini-embedding-001'),
  EMBEDDING_DIMS: z.coerce.number().int().positive().default(768),
  // Block creating meetings / sending invites until the email address is verified.
  REQUIRE_EMAIL_VERIFICATION: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),
  // Email (password reset, invitations), e.g. smtps://user:pass@smtp.resend.com:465
  SMTP_URL: z.string().optional(),
  MAIL_FROM: z.string().default('AuMeet <no-reply@aumeet.local>'),
  // Delete transcripts, notes and memory older than this many days (0 = keep forever).
  DATA_RETENTION_DAYS: z.coerce.number().int().min(0).default(0),
  // Audit events are kept this long (TTL index on audit_events).
  AUDIT_RETENTION_DAYS: z.coerce.number().int().min(30).default(365),
  // Name of an Atlas Vector Search index on memory_chunks.embedding (optional; in-app search otherwise).
  MEMORY_VECTOR_INDEX: z.string().optional(),
  // Recording (LiveKit Egress → S3-compatible storage: AWS S3, Cloudflare R2, MinIO…). Off unless set.
  RECORDING_S3_BUCKET: z.string().optional(),
  RECORDING_S3_REGION: z.string().default('us-east-1'),
  RECORDING_S3_ACCESS_KEY: z.string().optional(),
  RECORDING_S3_SECRET: z.string().optional(),
  RECORDING_S3_ENDPOINT: z.string().optional(),
  RECORDING_S3_FORCE_PATH_STYLE: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),
  // Must match AGENT_NAME in the agent worker (explicit dispatch).
  AGENT_NAME: z.string().default('aumeet'),
  // Where the web app lives (OAuth sends the user back here after sign-in).
  WEB_URL: z.string().url().default('http://localhost:4200'),
  // Public origin the browser uses to reach `/api`. In dev the Angular proxy serves
  // `/api` on :4200, which keeps the OAuth state cookie on the same origin.
  PUBLIC_API_URL: z.string().url().default('http://localhost:4200'),
  // Optional: each provider is enabled only when its credentials are set.
  GOOGLE_CLIENT_ID: z.string().optional(),
  GOOGLE_CLIENT_SECRET: z.string().optional(),
  GITHUB_CLIENT_ID: z.string().optional(),
  GITHUB_CLIENT_SECRET: z.string().optional(),
});

const parsed = EnvSchema.safeParse(process.env);

if (!parsed.success) {
  console.error('Invalid environment configuration:');
  for (const issue of parsed.error.issues) {
    console.error(`  - ${issue.path.join('.')}: ${issue.message}`);
  }
  process.exit(1);
}

export const env = {
  ...parsed.data,
  corsOrigins: parsed.data.CORS_ORIGINS.split(',').map((o) => o.trim()).filter(Boolean),
};
