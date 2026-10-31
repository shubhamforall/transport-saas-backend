import { createApp } from './app.js';
import { env } from './config/env.js';
import { prisma } from './services/prisma.js';
import { syncPlatformAdmins } from './services/platform-admins.js';
import { ensureDefaultPlans } from './services/default-plans.js';
import { logger } from './utils/logger.js';

const app = createApp();

const server = app.listen(env.PORT, () => {
  logger.info(`Vaharo API listening on port ${env.PORT}`);
  // First-run setup; never blocks or crashes startup. Super Admins are also applied on sign-in.
  void (async () => {
    try {
      await ensureDefaultPlans();
      await syncPlatformAdmins();
    } catch (err) {
      logger.warn({ err }, 'Startup setup (default plans / Super Admins) did not complete');
    }
  })();
});

function shutdown(signal: string) {
  logger.info(`${signal} received, shutting down`);
  server.close(() => {
    void prisma.$disconnect().finally(() => process.exit(0));
  });
  setTimeout(() => process.exit(1), 10_000).unref();
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
