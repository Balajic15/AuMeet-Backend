import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { classify, geminiKeysFromEnv, KeyPool, modelsForTask, retryAfterMs, type UsageEvent } from '../src/ai/pool.js';
import { geminiStructured } from '../src/gemini.js';
import { UsageMeter } from '../src/ai/usage.js';

const Out = z.object({ ok: z.boolean() });

/** Fake Gemini: per (key, model) a queue of outcomes; records the calls. */
function fakeClients(behaviour: (key: string, model: string, n: number) => 'ok' | Error) {
  const calls: Array<{ key: string; model: string; images: number }> = [];
  const make = (key: string) => ({
    models: {
      generateContent: async (req: { model: string; contents: unknown }) => {
        const n = calls.filter((c) => c.key === key && c.model === req.model).length;
        const images = Array.isArray(req.contents) ? (req.contents as Array<{ parts: unknown[] }>)[0]!.parts.length - 1 : 0;
        calls.push({ key, model: req.model, images });
        const r = behaviour(key, req.model, n);
        if (r instanceof Error) throw r;
        return { text: '{"ok":true}', usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 2 } };
      },
    },
  });
  return { calls, make: make as never };
}

describe('API keys and models', () => {
  it('collects every configured key, deduplicated, in order', () => {
    expect(geminiKeysFromEnv({ GOOGLE_API_KEY: 'a', GEMINI_API_KEY_3: 'c', GEMINI_API_KEY_2: 'b', GEMINI_API_KEYS: 'd, a' })).toEqual(['a', 'd', 'b', 'c']);
    expect(modelsForTask('vision', ['lite'], { GEMINI_MODELS_VISION: 'flash, lite' })).toEqual(['flash', 'lite']);
    expect(modelsForTask('notes', ['lite'], {})).toEqual(['lite']);
  });

  it('classifies errors and reads Google retry delays', () => {
    expect(classify(new Error('429 RESOURCE_EXHAUSTED'))).toBe('quota');
    expect(classify(new Error('400 API key not valid. Please pass a valid API key.'))).toBe('auth');
    expect(classify(new Error('503 UNAVAILABLE: high demand'))).toBe('overload');
    expect(classify(new SyntaxError('bad json'))).toBe('bad_output');
    expect(retryAfterMs(new Error('{"retryDelay": "34s"}'))).toBe(34_500);
  });

  it('rotates keys across calls and puts a cooling key last', () => {
    let t = 0;
    const pool = new KeyPool(['k1', 'k2', 'k3'], (k) => k, () => t);
    expect(pool.order().map((k) => k.client)).toEqual(['k1', 'k2', 'k3']);
    expect(pool.order().map((k) => k.client)).toEqual(['k2', 'k3', 'k1']);
    pool.cool(pool.order()[0]!, 10_000); // k3 cools
    expect(pool.order().map((k) => k.client)).toEqual(['k1', 'k2']);
    t = 20_000;
    expect(pool.order()).toHaveLength(3);
  });

  it('a rate-limited key falls through to the next key, then cools; overload moves to the next model', async () => {
    const usage: UsageEvent[] = [];
    const { calls, make } = fakeClients((key, model) => (key === 'k1' ? new Error('429 RESOURCE_EXHAUSTED "retryDelay": "30s"') : model === 'lite' && key === 'k2' ? new Error('503 UNAVAILABLE') : 'ok'));
    const call = geminiStructured({ apiKeys: ['k1', 'k2'], models: ['lite', 'flash'], thinking: 'off', makeClient: make, onUsage: (u) => usage.push(u) });
    expect(await call(Out, { system: 's', prompt: 'p', task: 'notes' })).toEqual({ ok: true });
    // k1 quota → k2 on the same model → overload → next model.
    // k1 is cooling now, so the next model goes straight to k2.
    expect(calls.map((c) => `${c.key}/${c.model}`)).toEqual(['k1/lite', 'k2/lite', 'k2/flash']);
    expect(usage.at(-1)).toMatchObject({ ok: true, task: 'notes', inputTokens: 10, outputTokens: 2 });
    expect(usage.filter((u) => u.error === 'quota').length).toBeGreaterThan(0);
  });

  it('sends images for vision and uses the task’s models', async () => {
    const { calls, make } = fakeClients(() => 'ok');
    const call = geminiStructured({ apiKeys: ['k1'], models: ['lite'], thinking: 'off', makeClient: make, env: { GEMINI_MODELS_VISION: 'flash' } });
    await call(Out, { system: 's', prompt: 'look', task: 'vision', images: [{ mimeType: 'image/png', data: 'AAAA' }] });
    expect(calls[0]).toEqual({ key: 'k1', model: 'flash', images: 1 });
  });

  it('a fatal error is not retried on other models', async () => {
    const { calls, make } = fakeClients(() => new Error('400 INVALID_ARGUMENT: bad request'));
    const call = geminiStructured({ apiKeys: ['k1', 'k2'], models: ['lite', 'flash'], thinking: 'off', makeClient: make });
    await expect(call(Out, { system: 's', prompt: 'p' })).rejects.toThrow('INVALID_ARGUMENT');
    expect(calls).toHaveLength(1);
  });

  it('meters usage per task, model and key slot', () => {
    const m = new UsageMeter('agent');
    m.add({ task: 'notes', model: 'lite', keyId: 1, ok: true, ms: 100, inputTokens: 50, outputTokens: 5 });
    m.add({ task: 'notes', model: 'lite', keyId: 1, ok: false, ms: 20, inputTokens: 0, outputTokens: 0, error: 'quota' });
    expect(m.snapshot()[0]).toMatchObject({ task: 'notes', keyId: 1, calls: 2, failures: 1, inputTokens: 50, errors: { quota: 1 } });
  });
});
