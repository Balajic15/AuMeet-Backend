import { GoogleGenAI } from '@google/genai';
import { z } from 'zod';
import { classify, KeyPool, modelsForTask, retryAfterMs, type UsageEvent } from './ai/pool.js';

/**
 * Calls Gemini with a JSON schema and validates the reply with the same zod schema.
 * `task` picks the models for the job (GEMINI_MODELS_<TASK>); `images` makes it a vision call.
 */
export type StructuredCall = <T>(
  schema: z.ZodType<T>,
  opts: {
    system: string;
    prompt: string;
    temperature?: number;
    timeoutMs?: number;
    task?: string;
    images?: Array<{ mimeType: string; data: string }>;
  },
) => Promise<T>;

export interface GeminiOptions {
  /** Every configured key; calls rotate over them and skip keys that are rate-limited. */
  apiKeys: string[];
  /** Default models, tried in order: primary first, then fallbacks. */
  models: string[];
  /** 'minimal' keeps latency low; 'off' sends no thinking setting at all. */
  thinking: 'minimal' | 'low' | 'off';
  defaultTimeoutMs?: number;
  /** Per-task model lists (GEMINI_MODELS_<TASK>). */
  env?: Record<string, string | undefined>;
  /** Every attempt, for usage tracking and cost control. */
  onUsage?: (u: UsageEvent) => void;
  /** Tests only. */
  makeClient?: (key: string) => Pick<GoogleGenAI, 'models'>;
}

/** Overload, quota, timeout, server errors – worth trying the next model. */
export function isRetryable(err: unknown): boolean {
  const k = classify(err);
  return k === 'quota' || k === 'overload';
}

/** Some models reject a given thinking level – retry that model without the setting. */
function isThinkingUnsupported(err: unknown): boolean {
  return /thinking (level|budget)[^"]*not supported|thinking is not supported/i.test(String((err as Error)?.message ?? err));
}

export function parseModels(primary: string, fallbacks: string | undefined): string[] {
  return [...new Set([primary, ...(fallbacks ?? '').split(',')].map((m) => m.trim()).filter(Boolean))];
}

/** An invalid or revoked key is set aside this long. */
const AUTH_COOLDOWN_MS = 60 * 60_000;

export function geminiStructured(o: GeminiOptions): StructuredCall {
  const pool = new KeyPool(o.apiKeys, o.makeClient ?? ((apiKey) => new GoogleGenAI({ apiKey })));
  const schemas = new WeakMap<object, Record<string, unknown>>();
  const noThinking = new Set<string>();

  const jsonSchemaFor = (schema: z.ZodType): Record<string, unknown> => {
    let s = schemas.get(schema);
    if (!s) {
      s = z.toJSONSchema(schema, { target: 'draft-7' }) as Record<string, unknown>;
      delete s['$schema'];
      schemas.set(schema, s);
    }
    return s;
  };

  return async (schema, { system, prompt, temperature = 0.1, timeoutMs, task = 'default', images }) => {
    const models = modelsForTask(task, o.models, o.env ?? {});
    const contents = images?.length
      ? [{ role: 'user', parts: [{ text: prompt }, ...images.map((i) => ({ inlineData: { mimeType: i.mimeType, data: i.data } }))] }]
      : prompt;
    let lastErr: unknown;
    for (const model of models) {
      // Each model gets every available key; a rate-limited key is skipped, not fatal.
      for (const key of pool.order()) {
        let tryAgain = true;
        while (tryAgain) {
          tryAgain = false;
          const thinking = o.thinking !== 'off' && !noThinking.has(model);
          const t = Date.now();
          try {
            const res = await key.client.models.generateContent({
              model,
              contents,
              config: {
                systemInstruction: system,
                temperature,
                responseMimeType: 'application/json',
                responseJsonSchema: jsonSchemaFor(schema),
                abortSignal: AbortSignal.timeout(timeoutMs ?? o.defaultTimeoutMs ?? 20_000),
                ...(thinking ? { thinkingConfig: { thinkingLevel: o.thinking.toUpperCase() } as never } : {}),
              },
            });
            if (!res.text) throw new Error('Empty response from Gemini');
            const out = schema.parse(JSON.parse(res.text));
            o.onUsage?.({
              task, model, keyId: key.id, ok: true, ms: Date.now() - t,
              inputTokens: res.usageMetadata?.promptTokenCount ?? 0, outputTokens: res.usageMetadata?.candidatesTokenCount ?? 0,
            });
            return out;
          } catch (err) {
            lastErr = err;
            if (thinking && isThinkingUnsupported(err)) {
              noThinking.add(model); // remember, and retry this model without it
              tryAgain = true;
              continue;
            }
            const kind = classify(err);
            o.onUsage?.({ task, model, keyId: key.id, ok: false, ms: Date.now() - t, inputTokens: 0, outputTokens: 0, error: kind });
            if (kind === 'quota') pool.cool(key, retryAfterMs(err));
            else if (kind === 'auth') pool.cool(key, AUTH_COOLDOWN_MS);
          }
        }
        const kind = classify(lastErr);
        // Quota or a bad key: the next key may work for the same model. Anything else: next model.
        if (kind !== 'quota' && kind !== 'auth') break;
      }
      const kind = classify(lastErr);
      if (kind === 'fatal') throw lastErr;
    }
    throw lastErr;
  };
}
