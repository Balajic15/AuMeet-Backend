import { env } from './config/env.js';
import { connectDb, disconnectDb } from './db.js';
import { createApp } from './app.js';
import { logger } from './logger.js';
import { ensureDefaultProfile } from './services/aiBehaviour.js';

async function main() {
  await connectDb(env.MONGODB_URI);
  await ensureDefaultProfile();
  const app = createApp();
  const server = app.listen(env.PORT, () => {
    logger.info(`MeetMind API listening on http://localhost:${env.PORT}`);
  });

  const shutdown = (signal: string) => {
    logger.info(`${signal} received, shutting down…`);
    server.close(async () => {
      await disconnectDb();
      process.exit(0);
    });
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch((err) => {
  logger.error({ err }, 'failed to start server');
  process.exit(1);
});
