import { GoogleGenAI } from '@google/genai';
import { z } from 'zod';

/** Calls Gemini with a JSON schema and validates the reply with the same zod schema. */
export type StructuredCall = <T>(
  schema: z.ZodType<T>,
  opts: { system: string; prompt: string; temperature?: number },
) => Promise<T>;

export function geminiStructured(apiKey: string, model: string): StructuredCall {
  const ai = new GoogleGenAI({ apiKey });
  const schemas = new WeakMap<object, Record<string, unknown>>();

  const jsonSchemaFor = (schema: z.ZodType): Record<string, unknown> => {
    let s = schemas.get(schema);
    if (!s) {
      s = z.toJSONSchema(schema, { target: 'draft-7' }) as Record<string, unknown>;
      delete s['$schema'];
      schemas.set(schema, s);
    }
    return s;
  };

  return async (schema, { system, prompt, temperature = 0.1 }) => {
    const res = await ai.models.generateContent({
      model,
      contents: prompt,
      config: {
        systemInstruction: system,
        temperature,
        responseMimeType: 'application/json',
        responseJsonSchema: jsonSchemaFor(schema),
      },
    });
    const text = res.text;
    if (!text) throw new Error('Empty response from Gemini');
    return schema.parse(JSON.parse(text));
  };
}
