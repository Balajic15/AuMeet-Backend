import type { Db } from 'mongodb';
import { log } from '@livekit/agents';
import type { UsageEvent } from './pool.js';

/*
 * Usage tracking for cost control: calls, failures, tokens and time per day × source × task × model × key slot
 * (`ai_usage`, one document per combination). Collected in memory and flushed every minute, so tracking never
 * slows a reply down. Keys are recorded by position only, never the key itself.
 */

interface Bucket {
  calls: number;
  failures: number;
  inputTokens: number;
  outputTokens: number;
  ms: number;
  errors: Record<string, number>;
}

export class UsageMeter {
  private buckets = new Map<string, Bucket>();
  private db: Db | null = null;
  private timer: NodeJS.Timeout | null = null;

  constructor(private readonly source: string, private readonly flushMs = 60_000) {}

  attach(db: Db): void {
    this.db = db;
    this.timer ??= setInterval(() => void this.flush(), this.flushMs);
    this.timer.unref?.();
  }

  add(u: UsageEvent): void {
    const day = new Date().toISOString().slice(0, 10);
    const k = [day, u.task, u.model, u.keyId].join('|');
    const b = this.buckets.get(k) ?? { calls: 0, failures: 0, inputTokens: 0, outputTokens: 0, ms: 0, errors: {} };
    b.calls++;
    if (!u.ok) {
      b.failures++;
      if (u.error) b.errors[u.error] = (b.errors[u.error] ?? 0) + 1;
    }
    b.inputTokens += u.inputTokens;
    b.outputTokens += u.outputTokens;
    b.ms += u.ms;
    this.buckets.set(k, b);
    if (!u.ok && u.error === 'quota') {
      try {
        log().info({ task: u.task, model: u.model, key: u.keyId }, 'API key rate-limited; using the next one');
      } catch {
        /* logger not initialised (tests, scripts) */
      }
    }
  }

  /** Totals collected since the last flush (for logs and tests). */
  snapshot(): Array<{ day: string; task: string; model: string; keyId: number } & Bucket> {
    return [...this.buckets.entries()].map(([k, b]) => {
      const [day, task, model, keyId] = k.split('|');
      return { day: day!, task: task!, model: model!, keyId: Number(keyId), ...b };
    });
  }

  async flush(): Promise<void> {
    if (!this.db || !this.buckets.size) return;
    const rows = this.snapshot();
    this.buckets = new Map();
    try {
      await this.db.collection('ai_usage').bulkWrite(
        rows.map((r) => ({
          updateOne: {
            filter: { day: r.day, source: this.source, task: r.task, model: r.model, keyId: r.keyId },
            update: {
              $inc: {
                calls: r.calls, failures: r.failures, inputTokens: r.inputTokens, outputTokens: r.outputTokens, ms: r.ms,
                ...Object.fromEntries(Object.entries(r.errors).map(([e, n]) => [`errors.${e}`, n])),
              },
              $set: { updatedAt: new Date() },
            },
            upsert: true,
          },
        })),
      );
    } catch (err) {
      log().warn({ err }, 'could not save AI usage');
    }
  }

  async close(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await this.flush();
  }
}
