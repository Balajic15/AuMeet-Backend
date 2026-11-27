import { Queue } from 'bullmq';

export const MEMORY_QUEUE = 'aumeet-memory';

export interface ProcessSessionJob {
  sessionId: string;
}

/** BullMQ needs `maxRetriesPerRequest: null` for blocking worker connections. */
export function redisConnection(url: string) {
  return { url, maxRetriesPerRequest: null };
}

export function createMemoryQueue(url: string): Queue {
  return new Queue(MEMORY_QUEUE, { connection: redisConnection(url) });
}

/** One job per session; the jobId de-duplicates while a job is waiting or running. */
export async function enqueueSession(queue: Queue, sessionId: string): Promise<void> {
  await queue.add('process-session', { sessionId } satisfies ProcessSessionJob, {
    jobId: `session-${sessionId}`,
    attempts: 3,
    backoff: { type: 'exponential', delay: 30_000 },
    removeOnComplete: true,
    removeOnFail: 200,
  });
}
