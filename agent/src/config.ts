import 'dotenv/config';
import { z } from 'zod';

const Env = z.object({
  LIVEKIT_URL: z.string().min(1, 'LIVEKIT_URL is required'),
  LIVEKIT_API_KEY: z.string().min(1, 'LIVEKIT_API_KEY is required'),
  LIVEKIT_API_SECRET: z.string().min(1, 'LIVEKIT_API_SECRET is required'),
  AGENT_NAME: z.string().default('aumeet'),
  DEEPGRAM_API_KEY: z.string().min(1, 'DEEPGRAM_API_KEY is required'),
  GOOGLE_API_KEY: z.string().min(1, 'GOOGLE_API_KEY is required'),
  // Fast models first: a live conversation needs ~1 s answers. Measured Nov 2026:
  // 3.5-flash-lite ~1 s, 3-flash-preview ~1.3 s, 3.5-flash 10–100 s under load.
  GEMINI_MODEL: z.string().default('gemini-3.5-flash-lite'),
  // Tried in order when the primary is overloaded (503), over quota (429) or too slow.
  GEMINI_FALLBACK_MODELS: z.string().default('gemini-3-flash-preview,gemini-3.1-flash-lite'),
  // Internal "thinking" before answering. 'minimal' keeps replies fast.
  GEMINI_THINKING: z.enum(['minimal', 'low', 'off']).default('minimal'),
  // Deadline per model attempt for spoken/chat replies before trying the next model. Google rejects
  // deadlines under 10 s, so values below that are raised to 10.
  VOICE_LLM_TIMEOUT_SECONDS: z.coerce.number().min(1).max(120).default(12),
  CARTESIA_API_KEY: z.string().min(1, 'CARTESIA_API_KEY is required'),
  CARTESIA_VOICE_ID: z.string().optional(),
  CARTESIA_MODEL: z.string().default('sonic-3.6'),
  MONGODB_URI: z.string().optional(),
  // Must match the server worker so history search compares like with like.
  EMBEDDING_MODEL: z.string().default('gemini-embedding-001'),
  EMBEDDING_DIMS: z.coerce.number().int().positive().default(768),
});

export type Config = z.infer<typeof Env>;

let cached: Config | null = null;

/** Validated lazily so unit tests can import modules without real keys. */
export function config(): Config {
  if (cached) return cached;
  const parsed = Env.safeParse(process.env);
  if (!parsed.success) {
    const lines = parsed.error.issues.map((i) => `  - ${i.path.join('.')}: ${i.message}`);
    throw new Error(`Invalid agent environment:\n${lines.join('\n')}`);
  }
  cached = parsed.data;
  return cached;
}

/** Display name of the AI participant tile and transcript lines (deployment setting, AGENT_DISPLAY_NAME). */
export const AGENT_DISPLAY_NAME = process.env['AGENT_DISPLAY_NAME']?.trim() || 'AuMeet AI';
