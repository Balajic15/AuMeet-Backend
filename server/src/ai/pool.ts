/*
 * Multi-key, multi-model routing for model calls (kept in sync with agent/src/ai/pool.ts).
 *
 *  - Keys: GOOGLE_API_KEY plus GEMINI_API_KEY_2, _3 … (or GEMINI_API_KEYS=a,b,c). Calls rotate over the keys; a key
 *    that hits its rate limit cools down for as long as Google says (retryDelay) and the next key is used; an invalid
 *    or revoked key is set aside for an hour. One bad key never stops the meeting.
 *  - Models per task: GEMINI_MODELS_<TASK> (e.g. GEMINI_MODELS_VISION=gemini-3-flash-preview,gemini-3.5-flash-lite),
 *    falling back to GEMINI_MODEL + GEMINI_FALLBACK_MODELS. Cheap, fast models by default; capable ones only where a
 *    task is configured to need them.
 *  - Errors: overload / timeout → next model; quota → next key; schema/JSON errors → next model.
 */

export type ErrorKind = 'quota' | 'auth' | 'overload' | 'bad_output' | 'fatal';

export function classify(err: unknown): ErrorKind {
  const msg = String((err as Error)?.message ?? err);
  if (err instanceof SyntaxError || (err as { name?: string })?.name === 'ZodError') return 'bad_output';
  if (/\b429\b|RESOURCE_EXHAUSTED|quota|rate limit/i.test(msg)) return 'quota';
  if (/API_KEY_INVALID|API key not valid|PERMISSION_DENIED|\b401\b|\b403\b|unregistered callers|API key expired/i.test(msg)) return 'auth';
  if (/\b(500|502|503|504)\b|UNAVAILABLE|overloaded|high demand|aborted|timed? ?out|ECONNRESET|fetch failed|Empty response|INTERNAL/i.test(msg)) return 'overload';
  return 'fatal';
}

/** Google's "retryDelay": "34s" in quota errors; otherwise a minute. */
export function retryAfterMs(err: unknown, fallbackMs = 60_000): number {
  const m = /retry(?:Delay| in)["':\s]*([\d.]+)\s*s/i.exec(String((err as Error)?.message ?? err));
  return m ? Math.min(15 * 60_000, Math.ceil(Number(m[1]) * 1000) + 500) : fallbackMs;
}

export interface PooledKey<C> {
  /** 1-based position, for logs and usage (never the key itself). */
  id: number;
  client: C;
  coolUntil: number;
}

export class KeyPool<C> {
  private readonly keys: PooledKey<C>[];
  private cursor = 0;

  constructor(apiKeys: string[], make: (key: string) => C, private readonly now: () => number = Date.now) {
    const unique = [...new Set(apiKeys.map((k) => k.trim()).filter(Boolean))];
    if (!unique.length) throw new Error('No API key configured');
    this.keys = unique.map((k, i) => ({ id: i + 1, client: make(k), coolUntil: 0 }));
  }

  get size(): number {
    return this.keys.length;
  }

  /** Keys to try for one call, best first: available ones in rotation, then the one that frees up soonest. */
  order(): PooledKey<C>[] {
    const t = this.now();
    const start = this.cursor++ % this.keys.length;
    const rotated = [...this.keys.slice(start), ...this.keys.slice(0, start)];
    const ready = rotated.filter((k) => k.coolUntil <= t);
    return ready.length ? ready : [...rotated].sort((a, b) => a.coolUntil - b.coolUntil).slice(0, 1);
  }

  cool(key: PooledKey<C>, ms: number): void {
    key.coolUntil = Math.max(key.coolUntil, this.now() + ms);
  }

  status(): Array<{ id: number; coolingForMs: number }> {
    const t = this.now();
    return this.keys.map((k) => ({ id: k.id, coolingForMs: Math.max(0, k.coolUntil - t) }));
  }
}

/** All configured Gemini keys from the environment. */
export function geminiKeysFromEnv(env: Record<string, string | undefined>): string[] {
  const numbered = Object.keys(env)
    .map((k) => /^GEMINI_API_KEY_(\d+)$/.exec(k))
    .filter((m): m is RegExpExecArray => !!m)
    .sort((a, b) => Number(a[1]) - Number(b[1]))
    .map((m) => env[m[0]] ?? '');
  return [...new Set([env['GOOGLE_API_KEY'] ?? '', env['GEMINI_API_KEY'] ?? '', ...(env['GEMINI_API_KEYS'] ?? '').split(','), ...numbered].map((k) => k.trim()).filter(Boolean))];
}

/** Models for a task: GEMINI_MODELS_<TASK>, else the defaults. */
export function modelsForTask(task: string | undefined, defaults: string[], env: Record<string, string | undefined>): string[] {
  const custom = task ? env[`GEMINI_MODELS_${task.toUpperCase()}`] : undefined;
  const list = custom ? custom.split(',').map((m) => m.trim()).filter(Boolean) : [];
  return list.length ? [...new Set(list)] : defaults;
}

export interface UsageEvent {
  task: string;
  model: string;
  keyId: number;
  ok: boolean;
  ms: number;
  inputTokens: number;
  outputTokens: number;
  error?: ErrorKind;
}
