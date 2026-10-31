import { execSync } from 'node:child_process';

/** Applies migrations to the test database once before the test run. */
export default function setup() {
  const url = process.env.TEST_DATABASE_URL ?? 'mysql://vaharo:vaharo@localhost:3307/vaharo_test';
  if (!new URL(url).pathname.endsWith('_test')) {
    throw new Error('TEST_DATABASE_URL must point to a database whose name ends in "_test".');
  }
  execSync('npx prisma migrate deploy', {
    stdio: 'pipe',
    env: { ...process.env, DATABASE_URL: url },
  });
}
