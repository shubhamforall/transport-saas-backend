import 'dotenv/config';
import { z } from 'zod';

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(4000),
  WEB_ORIGIN: z
    .string()
    .default('http://localhost:5173')
    .transform((value) =>
      value
        .split(',')
        .map((origin) => origin.trim())
        .filter(Boolean),
    ),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),

  DATABASE_URL: z.string().regex(/^(mysql|mariadb):\/\//, 'must be a mysql:// connection string'),

  JWT_ACCESS_SECRET: z.string().min(32, 'must be at least 32 characters'),
  /** Access-token lifetime, e.g. "15m", "1h". */
  JWT_ACCESS_TTL: z
    .string()
    .regex(/^\d+[smh]$/, 'use a number followed by s, m or h (e.g. 15m)')
    .default('15m'),
  REFRESH_TOKEN_TTL_DAYS: z.coerce.number().int().min(1).max(90).default(30),
  /** Optional cookie Domain, e.g. ".vaharo.in" when frontend and API share a parent domain. */
  COOKIE_DOMAIN: z.string().optional(),

  /** bcrypt work factor. Lower it only in tests. */
  BCRYPT_COST: z.coerce.number().int().min(4).max(15).default(12),
  /** Requests per 15 minutes per IP for login/register/refresh. */
  AUTH_RATE_LIMIT_MAX: z.coerce.number().int().positive().default(20),

  /** Public URL of the web app, used in emailed links. */
  APP_BASE_URL: z.url().default('http://localhost:5173'),

  // Email (Milestone 5). Without SMTP_HOST, development saves emails to tmp/outbox instead.
  SMTP_HOST: z.string().optional(),
  SMTP_PORT: z.coerce.number().int().positive().default(587),
  SMTP_SECURE: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),
  SMTP_USER: z.string().optional(),
  SMTP_PASSWORD: z.string().optional(),
  SMTP_FROM_NAME: z.string().default('Vaharo'),
  SMTP_FROM_EMAIL: z.string().optional(),

  // Subscriptions (Milestone 7).
  TRIAL_DAYS: z.coerce.number().int().min(0).max(90).default(14),
  /** Days a past-due subscription keeps full access before becoming read-only. */
  PAST_DUE_GRACE_DAYS: z.coerce.number().int().min(0).max(60).default(7),
  RAZORPAY_KEY_ID: z.string().optional(),
  RAZORPAY_KEY_SECRET: z.string().optional(),
  RAZORPAY_WEBHOOK_SECRET: z.string().optional(),
});

export type Env = z.infer<typeof envSchema>;

/** Settings that are fine locally but unsafe on a live server. */
function productionProblems(e: Env): string[] {
  const problems: string[] = [];
  if (/replace-with|change-me|test-only/i.test(e.JWT_ACCESS_SECRET)) {
    problems.push('JWT_ACCESS_SECRET: still a placeholder; generate a long random secret');
  }
  if (e.WEB_ORIGIN.some((o) => !o.startsWith('https://'))) {
    problems.push('WEB_ORIGIN: production origins must use https://');
  }
  if (!e.APP_BASE_URL.startsWith('https://')) problems.push('APP_BASE_URL: must use https://');
  if (!e.SMTP_HOST || !e.SMTP_FROM_EMAIL) {
    problems.push('SMTP_HOST / SMTP_FROM_EMAIL: required to send invoices and password resets');
  }
  if (e.BCRYPT_COST < 10) problems.push('BCRYPT_COST: use 10 or more in production');
  return problems;
}

function loadEnv(): Env {
  const parsed = envSchema.safeParse(process.env);
  if (!parsed.success) {
    // Print only the variable names and problems, never the values.
    const issues = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`);
    throw new Error(`Invalid environment configuration:\n${issues.join('\n')}`);
  }
  if (parsed.data.NODE_ENV === 'production') {
    const problems = productionProblems(parsed.data);
    if (problems.length) {
      throw new Error(`Unsafe production configuration:\n${problems.join('\n')}`);
    }
  }
  return parsed.data;
}

export const env = loadEnv();
export const isProduction = env.NODE_ENV === 'production';

/** Converts "15m" style durations to seconds. */
export function durationToSeconds(value: string): number {
  const amount = Number(value.slice(0, -1));
  const unit = value.slice(-1);
  return amount * (unit === 'h' ? 3600 : unit === 'm' ? 60 : 1);
}
