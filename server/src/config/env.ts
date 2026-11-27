import 'dotenv/config';
import { z } from 'zod';

const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(4000),
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
  // Gemini – used by the worker (recaps, embeddings) and by "Ask your meetings".
  GOOGLE_API_KEY: z.string().optional(),
  GEMINI_MODEL: z.string().default('gemini-3.5-flash'),
  EMBEDDING_MODEL: z.string().default('gemini-embedding-001'),
  EMBEDDING_DIMS: z.coerce.number().int().positive().default(768),
  // Email (password reset, invitations), e.g. smtps://user:pass@smtp.resend.com:465
  SMTP_URL: z.string().optional(),
  MAIL_FROM: z.string().default('AuMeet <no-reply@aumeet.local>'),
  // Delete transcripts, notes and memory older than this many days (0 = keep forever).
  DATA_RETENTION_DAYS: z.coerce.number().int().min(0).default(0),
  // Name of an Atlas Vector Search index on memory_chunks.embedding (optional; in-app search otherwise).
  MEMORY_VECTOR_INDEX: z.string().optional(),
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
