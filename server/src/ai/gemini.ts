import { GoogleGenAI } from '@google/genai';
import mongoose from 'mongoose';
import { z } from 'zod';
import { env } from '../config/env.js';
import { logger } from '../logger.js';
import { HttpError } from '../utils/httpError.js';
import { classify, geminiKeysFromEnv, KeyPool, modelsForTask, retryAfterMs, type UsageEvent } from './pool.js';

/** The things the server needs from a model. Injected so tests can fake it. */
export interface AiClient {
  structured<T>(
    schema: z.ZodType<T>,
    opts: { system: string; prompt: string; temperature?: number; task?: string; images?: Array<{ mimeType: string; data: string }> },
  ): Promise<T>;
  /** Unit-length vectors, one per text. */
  embed(texts: string[], kind: 'document' | 'query'): Promise<number[][]>;
}

const EMBED_BATCH = 100;
/** An invalid or revoked key is set aside this long. */
const AUTH_COOLDOWN_MS = 60 * 60_000;

export function normalizeVector(v: number[]): number[] {
  const len = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
  return len > 0 ? v.map((x) => x / len) : v;
}

/** Overload, quota, timeout or server errors – worth trying the next model or key. */
export function isRetryable(err: unknown): boolean {
  const k = classify(err);
  return k === 'quota' || k === 'overload';
}

export function geminiClient(opts: {
  /** Every configured key (rotated; rate-limited keys are skipped). */
  apiKeys: string[];
  /** Default models, primary first, then fallbacks; GEMINI_MODELS_<TASK> overrides per task. */
  models: string[];
  thinking: 'minimal' | 'low' | 'off';
  embeddingModel: string;
  dims: number;
  timeoutMs?: number;
  env?: Record<string, string | undefined>;
  onUsage?: (u: UsageEvent) => void;
  makeClient?: (key: string) => Pick<GoogleGenAI, 'models'>;
}): AiClient {
  const pool = new KeyPool(opts.apiKeys, opts.makeClient ?? ((apiKey) => new GoogleGenAI({ apiKey })));
  const schemaCache = new WeakMap<object, Record<string, unknown>>();
  const noThinking = new Set<string>();

  /** Run with the next usable key; quota / bad keys move on to the next key. */
  async function withKey<T>(fn: (client: Pick<GoogleGenAI, 'models'>, keyId: number) => Promise<T>): Promise<T> {
    let last: unknown;
    for (const key of pool.order()) {
      try {
        return await fn(key.client, key.id);
      } catch (err) {
        last = err;
        const kind = classify(err);
        if (kind === 'quota') pool.cool(key, retryAfterMs(err));
        else if (kind === 'auth') pool.cool(key, AUTH_COOLDOWN_MS);
        else throw err;
      }
    }
    throw last;
  }

  return {
    async structured(schema, { system, prompt, temperature = 0.2, task = 'default', images }) {
      let json = schemaCache.get(schema);
      if (!json) {
        json = z.toJSONSchema(schema, { target: 'draft-7' }) as Record<string, unknown>;
        delete json['$schema'];
        schemaCache.set(schema, json);
      }
      const contents = images?.length
        ? [{ role: 'user', parts: [{ text: prompt }, ...images.map((i) => ({ inlineData: { mimeType: i.mimeType, data: i.data } }))] }]
        : prompt;
      let lastErr: unknown;
      for (const model of modelsForTask(task, opts.models, opts.env ?? {})) {
        for (let attempt = 0; attempt < 2; attempt++) {
          const thinking = opts.thinking !== 'off' && !noThinking.has(model);
          try {
            return await withKey(async (client, keyId) => {
              const t = Date.now();
              try {
                const res = await client.models.generateContent({
                  model,
                  contents,
                  config: {
                    systemInstruction: system,
                    temperature,
                    responseMimeType: 'application/json',
                    responseJsonSchema: json,
                    abortSignal: AbortSignal.timeout(opts.timeoutMs ?? 45_000),
                    ...(thinking ? { thinkingConfig: { thinkingLevel: opts.thinking.toUpperCase() } as never } : {}),
                  },
                });
                if (!res.text) throw new Error('Empty response from Gemini');
                const out = schema.parse(JSON.parse(res.text));
                opts.onUsage?.({
                  task, model, keyId, ok: true, ms: Date.now() - t,
                  inputTokens: res.usageMetadata?.promptTokenCount ?? 0, outputTokens: res.usageMetadata?.candidatesTokenCount ?? 0,
                });
                return out;
              } catch (err) {
                opts.onUsage?.({ task, model, keyId, ok: false, ms: Date.now() - t, inputTokens: 0, outputTokens: 0, error: classify(err) });
                throw err;
              }
            });
          } catch (err) {
            lastErr = err;
            if (thinking && /thinking[^"]*not supported/i.test(String((err as Error)?.message))) {
              noThinking.add(model);
              continue;
            }
            break;
          }
        }
        if (classify(lastErr) === 'fatal') throw lastErr;
      }
      throw lastErr;
    },

    async embed(texts, kind) {
      const out: number[][] = [];
      for (let i = 0; i < texts.length; i += EMBED_BATCH) {
        const batch = texts.slice(i, i + EMBED_BATCH);
        const res = await withKey((client) =>
          client.models.embedContent({
            model: opts.embeddingModel,
            contents: batch,
            config: {
              taskType: kind === 'query' ? 'RETRIEVAL_QUERY' : 'RETRIEVAL_DOCUMENT',
              outputDimensionality: opts.dims,
            },
          }),
        );
        const vectors = res.embeddings?.map((e) => e.values ?? []) ?? [];
        if (vectors.length !== batch.length) throw new Error('Embedding count mismatch');
        // Truncated (Matryoshka) embeddings must be re-normalised before cosine/dot-product search.
        out.push(...vectors.map(normalizeVector));
      }
      return out;
    },
  };
}

// ---------- usage (cost control) ----------

/** Same collection and shape as the agent's (agent/src/ai/usage.ts), source "server". */
function recordUsage(u: UsageEvent): void {
  if (mongoose.connection.readyState !== 1) return;
  const day = new Date().toISOString().slice(0, 10);
  void mongoose.connection
    .collection('ai_usage')
    .updateOne(
      { day, source: 'server', task: u.task, model: u.model, keyId: u.keyId },
      {
        $inc: { calls: 1, failures: u.ok ? 0 : 1, inputTokens: u.inputTokens, outputTokens: u.outputTokens, ms: u.ms, ...(u.error ? { [`errors.${u.error}`]: 1 } : {}) },
        $set: { updatedAt: new Date() },
      },
      { upsert: true },
    )
    .catch((err) => logger.warn({ err }, 'could not save AI usage'));
}

let client: AiClient | null = null;
let override: AiClient | null = null;

/** Gemini client from env. Throws 503 when no Gemini key is configured. */
export function getAi(): AiClient {
  if (override) return override;
  const apiKeys = geminiKeysFromEnv(process.env);
  if (!apiKeys.length) throw new HttpError(503, 'AI features are not configured on this server (GOOGLE_API_KEY)');
  client ??= geminiClient({
    apiKeys,
    models: [...new Set([env.GEMINI_MODEL, ...env.GEMINI_FALLBACK_MODELS.split(',')].map((m) => m.trim()).filter(Boolean))],
    thinking: env.GEMINI_THINKING,
    embeddingModel: env.EMBEDDING_MODEL,
    dims: env.EMBEDDING_DIMS,
    env: process.env,
    onUsage: recordUsage,
  });
  return client;
}

export function aiConfigured(): boolean {
  return !!override || geminiKeysFromEnv(process.env).length > 0;
}

/** Tests only. */
export function setAiForTests(ai: AiClient | null): void {
  override = ai;
}
