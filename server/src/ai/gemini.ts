import { GoogleGenAI } from '@google/genai';
import { z } from 'zod';
import { env } from '../config/env.js';
import { HttpError } from '../utils/httpError.js';

/** The two things the server needs from a model. Injected so tests can fake it. */
export interface AiClient {
  structured<T>(schema: z.ZodType<T>, opts: { system: string; prompt: string; temperature?: number }): Promise<T>;
  /** Unit-length vectors, one per text. */
  embed(texts: string[], kind: 'document' | 'query'): Promise<number[][]>;
}

const EMBED_BATCH = 100;

export function normalizeVector(v: number[]): number[] {
  const len = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
  return len > 0 ? v.map((x) => x / len) : v;
}

/** Overload, quota, timeout or server errors – worth trying the next model. */
export function isRetryable(err: unknown): boolean {
  return /\b(429|500|502|503|504)\b|UNAVAILABLE|RESOURCE_EXHAUSTED|overloaded|high demand|aborted|timed? ?out|ECONNRESET|fetch failed/i.test(
    String((err as Error)?.message ?? err),
  );
}

export function geminiClient(opts: {
  apiKey: string;
  /** Primary first, then fallbacks. */
  models: string[];
  thinking: 'minimal' | 'low' | 'off';
  embeddingModel: string;
  dims: number;
  timeoutMs?: number;
}): AiClient {
  const ai = new GoogleGenAI({ apiKey: opts.apiKey });
  const schemaCache = new WeakMap<object, Record<string, unknown>>();
  const noThinking = new Set<string>();

  return {
    async structured(schema, { system, prompt, temperature = 0.2 }) {
      let json = schemaCache.get(schema);
      if (!json) {
        json = z.toJSONSchema(schema, { target: 'draft-7' }) as Record<string, unknown>;
        delete json['$schema'];
        schemaCache.set(schema, json);
      }
      let lastErr: unknown;
      for (const model of opts.models) {
        for (let attempt = 0; attempt < 2; attempt++) {
          const thinking = opts.thinking !== 'off' && !noThinking.has(model);
          try {
            const res = await ai.models.generateContent({
              model,
              contents: prompt,
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
            return schema.parse(JSON.parse(res.text));
          } catch (err) {
            lastErr = err;
            if (thinking && /thinking[^"]*not supported/i.test(String((err as Error)?.message))) {
              noThinking.add(model);
              continue;
            }
            break;
          }
        }
        if (!isRetryable(lastErr) && !(lastErr instanceof SyntaxError) && !(lastErr instanceof z.ZodError)) throw lastErr;
      }
      throw lastErr;
    },

    async embed(texts, kind) {
      const out: number[][] = [];
      for (let i = 0; i < texts.length; i += EMBED_BATCH) {
        const batch = texts.slice(i, i + EMBED_BATCH);
        const res = await ai.models.embedContent({
          model: opts.embeddingModel,
          contents: batch,
          config: {
            taskType: kind === 'query' ? 'RETRIEVAL_QUERY' : 'RETRIEVAL_DOCUMENT',
            outputDimensionality: opts.dims,
          },
        });
        const vectors = res.embeddings?.map((e) => e.values ?? []) ?? [];
        if (vectors.length !== batch.length) throw new Error('Embedding count mismatch');
        // Truncated (Matryoshka) embeddings must be re-normalised before cosine/dot-product search.
        out.push(...vectors.map(normalizeVector));
      }
      return out;
    },
  };
}

let client: AiClient | null = null;
let override: AiClient | null = null;

/** Gemini client from env. Throws 503 when GOOGLE_API_KEY isn't configured. */
export function getAi(): AiClient {
  if (override) return override;
  if (!env.GOOGLE_API_KEY) throw new HttpError(503, 'AI features are not configured on this server (GOOGLE_API_KEY)');
  client ??= geminiClient({
    apiKey: env.GOOGLE_API_KEY,
    models: [...new Set([env.GEMINI_MODEL, ...env.GEMINI_FALLBACK_MODELS.split(',')].map((m) => m.trim()).filter(Boolean))],
    thinking: env.GEMINI_THINKING,
    embeddingModel: env.EMBEDDING_MODEL,
    dims: env.EMBEDDING_DIMS,
  });
  return client;
}

export function aiConfigured(): boolean {
  return !!override || !!env.GOOGLE_API_KEY;
}

/** Tests only. */
export function setAiForTests(ai: AiClient | null): void {
  override = ai;
}
