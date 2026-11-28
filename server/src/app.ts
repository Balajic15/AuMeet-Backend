import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import mongoose from 'mongoose';
import { pinoHttp } from 'pino-http';
import { randomUUID } from 'node:crypto';
import { env } from './config/env.js';
import { logger } from './logger.js';
import authRoutes from './routes/auth.js';
import meetingRoutes from './routes/meetings.js';
import memoryRoutes from './routes/memory.js';
import aiRoutes from './routes/ai.js';
import analyticsRoutes from './routes/analytics.js';
import integrationRoutes from './routes/integrations.js';
import internalRoutes from './routes/internal.js';
import livekitWebhook from './routes/livekitWebhook.js';
import { csrfGuard } from './middleware/auth.js';
import { auditMutations } from './services/audit.js';
import { errorHandler, notFoundHandler } from './middleware/error.js';

function limiter(limit: number) {
  return rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: env.NODE_ENV === 'test' ? 10_000 : limit,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
  });
}

export function createApp() {
  const app = express();

  // Real client IPs for rate limits and logs: trust exactly the proxies in front of us.
  app.set('trust proxy', env.TRUST_PROXY);
  app.disable('x-powered-by');
  app.use(
    pinoHttp({
      logger,
      genReqId: (req, res) => {
        const id = (req.headers['x-request-id'] as string) || randomUUID();
        res.setHeader('x-request-id', id);
        return id;
      },
      // Health checks every few seconds would drown the logs.
      autoLogging: { ignore: (req) => req.url === '/api/health' },
      customLogLevel: (_req, res, err) => (err || res.statusCode >= 500 ? 'error' : res.statusCode >= 400 ? 'warn' : 'info'),
    }),
  );
  app.use(helmet());
  app.use(cors({ origin: env.corsOrigins, credentials: true }));

  // Mounted before express.json(): the webhook needs the raw body for signature checks.
  app.use('/api/livekit/webhook', livekitWebhook);
  // Agent → server (signed with the shared LiveKit secret; raw body for the signature).
  app.use('/api/internal', limiter(600), internalRoutes);

  app.use(express.json({ limit: '100kb' }));
  app.use('/api', csrfGuard);
  // Every successful change (and every failed sign-in) goes to the audit log.
  app.use('/api', auditMutations);

  /** Liveness + readiness: 503 while the database is unreachable so orchestrators hold traffic. */
  app.get('/api/health', (_req, res) => {
    const db = mongoose.connection.readyState === 1;
    res.status(db ? 200 : 503).json({ ok: db, db: db ? 'connected' : 'disconnected' });
  });

  // Brute-force protection where credentials or emails are involved.
  app.use(['/api/auth/login', '/api/auth/register'], limiter(30));
  app.use('/api/auth/password', limiter(10));
  app.use('/api/auth/email', limiter(10));
  app.use('/api/auth', authRoutes);
  // Invitations send real email.
  app.use('/api/meetings/:code/invite', limiter(20));
  app.use('/api/meetings/:code/documents', limiter(60));
  // Model calls: learning from corrections, analytics recommendations, re-planning follow-ups.
  app.use(['/api/ai/feedback/learn', '/api/analytics/insights', '/api/meetings/:code/insights/:sessionId/actions/plan'], limiter(30));
  app.use('/api/meetings', meetingRoutes);
  // Each question costs an embedding + a model call.
  app.use('/api/memory/ask', limiter(40));
  app.use('/api/memory', memoryRoutes);
  app.use('/api/ai', aiRoutes);
  app.use('/api/analytics', analyticsRoutes);
  app.use('/api/integrations', limiter(120), integrationRoutes);

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
