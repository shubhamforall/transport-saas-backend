import 'dotenv/config';
import { defineConfig } from 'vitest/config';

// Tests always use a separate database, never the development one.
const testDatabaseUrl =
  process.env.TEST_DATABASE_URL ?? 'mysql://vaharo:vaharo@localhost:3307/vaharo_test';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    globalSetup: ['./tests/global-setup.ts'],
    // Test files share one database, so run them one at a time.
    fileParallelism: false,
    // End-to-end tests make many real database round trips.
    testTimeout: 30_000,
    env: {
      NODE_ENV: 'test',
      LOG_LEVEL: 'silent',
      DATABASE_URL: testDatabaseUrl,
      JWT_ACCESS_SECRET: 'test-only-secret-that-is-at-least-32-characters-long',
      BCRYPT_COST: '4',
      AUTH_RATE_LIMIT_MAX: '10000',
      WEB_ORIGIN: 'http://localhost:5173',
      // Test-only webhook secret; Razorpay API keys stay unset so no real calls are made.
      RAZORPAY_WEBHOOK_SECRET: 'whsec_test_secret_value',
      RAZORPAY_KEY_ID: '',
      RAZORPAY_KEY_SECRET: '',
      SMTP_HOST: '',
    },
  },
});
