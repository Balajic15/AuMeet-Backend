import { GoogleGenAI } from '@google/genai';
import { z } from 'zod';

/** Calls Gemini with a JSON schema and validates the reply with the same zod schema. */
export type StructuredCall = <T>(
  schema: z.ZodType<T>,
  opts: { system: string; prompt: string; temperature?: number; timeoutMs?: number },
) => Promise<T>;

export interface GeminiOptions {
  apiKey: string;
  /** Tried in order: primary first, then fallbacks (overload, quota, timeout or failure). */
  models: string[];
  /** 'minimal' keeps latency low; 'off' sends no thinking setting at all. */
  thinking: 'minimal' | 'low' | 'off';
  defaultTimeoutMs?: number;
}

/** Overload, quota, timeout, server errors – worth trying the next model. */
export function isRetryable(err: unknown): boolean {
  const msg = String((err as Error)?.message ?? err);
  return /\b(429|500|502|503|504)\b|UNAVAILABLE|RESOURCE_EXHAUSTED|overloaded|high demand|aborted|timed? ?out|ECONNRESET|fetch failed/i.test(msg);
}

/** Some models reject a given thinking level – retry that model without the setting. */
function isThinkingUnsupported(err: unknown): boolean {
  return /thinking (level|budget)[^"]*not supported|thinking is not supported/i.test(String((err as Error)?.message ?? err));
}

export function parseModels(primary: string, fallbacks: string | undefined): string[] {
  return [...new Set([primary, ...(fallbacks ?? '').split(',')].map((m) => m.trim()).filter(Boolean))];
}

export function geminiStructured(o: GeminiOptions): StructuredCall {
  const ai = new GoogleGenAI({ apiKey: o.apiKey });
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

  return async (schema, { system, prompt, temperature = 0.1, timeoutMs }) => {
    let lastErr: unknown;
    for (const model of o.models) {
      for (let attempt = 0; attempt < 2; attempt++) {
        const thinking = o.thinking !== 'off' && !noThinking.has(model);
        try {
          const res = await ai.models.generateContent({
            model,
            contents: prompt,
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
          return schema.parse(JSON.parse(res.text));
        } catch (err) {
          lastErr = err;
          if (thinking && isThinkingUnsupported(err)) {
            noThinking.add(model); // remember, and retry this model without it
            continue;
          }
          break; // next model
        }
      }
      if (!isRetryable(lastErr) && !(lastErr instanceof SyntaxError) && !(lastErr instanceof z.ZodError)) throw lastErr;
    }
    throw lastErr;
  };
}
