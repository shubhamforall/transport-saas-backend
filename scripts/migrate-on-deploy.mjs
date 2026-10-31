/**
 * Runs before `npm run build` (npm "prebuild" hook).
 *
 * On the live server (NODE_ENV=production) it applies pending database migrations, so a push
 * to GitHub that auto-deploys also updates the database. Locally and in CI it does nothing.
 * Set SKIP_DB_MIGRATE=1 to build a production bundle without touching a database.
 */
import { execSync } from 'node:child_process';

if (process.env.NODE_ENV !== 'production' || process.env.SKIP_DB_MIGRATE === '1') {
  process.exit(0);
}
if (!process.env.DATABASE_URL) {
  console.error('migrate-on-deploy: DATABASE_URL is not set; cannot apply migrations.');
  process.exit(1);
}
console.log('migrate-on-deploy: applying database migrations (prisma migrate deploy)...');
execSync('npx prisma migrate deploy', { stdio: 'inherit' });
