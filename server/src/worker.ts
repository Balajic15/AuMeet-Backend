/**
 * Background worker: `npm run worker` (separate process from the API).
 *
 * Every few minutes (MEMORY_SWEEP_SECONDS) a sweep finds finished meeting sessions without a recap and queues them.
 * Each job writes a recap and indexes the session into searchable memory.
 */
import { Worker } from 'bullmq';
import { env } from './config/env.js';
import { connectDb, disconnectDb } from './db.js';
import { getAi } from './ai/gemini.js';
import { findSessionsToProcess, processSession } from './memory/process.js';
import { purgeOldContent } from './memory/retention.js';
import { MEMORY_QUEUE, createMemoryQueue, enqueueSession, redisConnection, type ProcessSessionJob } from './queue.js';
import { logger } from './logger.js';

async function main() {
  if (!env.REDIS_URL) throw new Error('REDIS_URL is required for the worker');
  if (!env.GOOGLE_API_KEY) throw new Error('GOOGLE_API_KEY is required for the worker');

  await connectDb(env.MONGODB_URI);
  const ai = getAi();
  const queue = createMemoryQueue(env.REDIS_URL);

  await queue.upsertJobScheduler('sweep', { every: env.MEMORY_SWEEP_SECONDS * 1000 }, { name: 'sweep', opts: { removeOnComplete: true, removeOnFail: 50 } });
  if (env.DATA_RETENTION_DAYS > 0) {
    // Daily at 03:00 UTC.
    await queue.upsertJobScheduler('retention', { pattern: '0 3 * * *', tz: 'UTC' }, { name: 'retention', opts: { removeOnComplete: true, removeOnFail: 20 } });
  } else {
    await queue.removeJobScheduler('retention');
  }

  const worker = new Worker(
    MEMORY_QUEUE,
    async (job) => {
      if (job.name === 'retention') {
        const res = await purgeOldContent(env.DATA_RETENTION_DAYS);
        logger.info({ ...res, days: env.DATA_RETENTION_DAYS }, 'retention: old meeting content deleted');
        return res;
      }
      if (job.name === 'sweep') {
        const ids = await findSessionsToProcess();
        for (const id of ids) await enqueueSession(queue, id);
        return { queued: ids.length };
      }
      if (job.name === 'process-session') {
        const { sessionId } = job.data as ProcessSessionJob;
        const res = await processSession(sessionId, ai);
        logger.info({ sessionId, chunks: res.chunks, skipped: res.skipped }, 'session processed');
        return res;
      }
      throw new Error(`Unknown job ${job.name}`);
    },
    {
      connection: redisConnection(env.REDIS_URL),
      concurrency: 2,
      // Hosted Redis (e.g. Upstash) bills per command: poll an idle queue rarely.
      drainDelay: 30, // seconds a blocking wait lasts before polling again
      stalledInterval: 120_000,
    },
  );

  worker.on('failed', (job, err) => logger.error({ err, job: job?.name, jobId: job?.id }, 'job failed'));
  logger.info('AuMeet worker running (memory queue)');

  const shutdown = async () => {
    await worker.close();
    await queue.close();
    await disconnectDb();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => {
  logger.error({ err }, 'worker failed to start');
  process.exit(1);
});
