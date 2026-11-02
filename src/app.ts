import express, { Router } from 'express';
import helmet from 'helmet';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import { pinoHttp } from 'pino-http';
import { env } from './config/env.js';
import { logger } from './utils/logger.js';
import { requestId } from './middleware/request-id.js';
import { csrfProtection, CSRF_HEADER } from './middleware/csrf.js';
import { errorHandler, notFoundHandler } from './middleware/error-handler.js';
import { healthRouter } from './modules/health/health.routes.js';
import { createAuthRouter } from './modules/auth/auth.routes.js';
import { tenantsRouter } from './modules/tenants/tenants.routes.js';
import { plansRouter, razorpayWebhook } from './modules/subscriptions/subscriptions.routes.js';
import { invitationsRouter } from './modules/team/team.routes.js';
import { platformRouter } from './modules/platform/platform.routes.js';
import { contactRouter } from './modules/contact/contact.routes.js';

export interface AppOptions {
  /** Requests per 15 minutes per IP on auth endpoints. Defaults to AUTH_RATE_LIMIT_MAX. */
  authRateLimitMax?: number;
}

export function createApp(options: AppOptions = {}) {
  const app = express();

  app.disable('x-powered-by');
  // Hostinger and most hosts sit behind one reverse proxy; needed for correct client IPs.
  app.set('trust proxy', 1);

  // req.id is typed by pino-http; requestId middleware sets it first.
  app.use(requestId);
  app.use(
    pinoHttp({
      logger,
      genReqId: (req) => req.id,
      autoLogging: { ignore: (req) => req.url === '/health' },
    }),
  );
  app.use(helmet());
  app.use(
    cors({
      origin: env.WEB_ORIGIN,
      credentials: true, // auth uses HttpOnly cookies
      allowedHeaders: ['Content-Type', 'Accept', 'X-Request-Id', CSRF_HEADER],
      exposedHeaders: ['X-Request-Id'],
    }),
  );
  // Signed webhooks need the raw body, so this route comes before the JSON parser.
  app.post('/api/v1/billing/webhooks/razorpay', ...razorpayWebhook);

  app.use(express.json({ limit: '1mb' }));
  app.use(cookieParser());

  app.use('/health', healthRouter);

  const api = Router();
  api.use('/health', healthRouter);
  api.use(csrfProtection);
  api.use(
    '/auth',
    createAuthRouter({ rateLimitMax: options.authRateLimitMax ?? env.AUTH_RATE_LIMIT_MAX }),
  );
  api.use('/tenants', tenantsRouter);
  api.use('/plans', plansRouter);
  api.use('/invitations', invitationsRouter);
  api.use('/platform', platformRouter);
  api.use('/contact', contactRouter);
  app.use('/api/v1', api);

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
