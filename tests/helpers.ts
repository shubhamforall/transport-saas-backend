import request from 'supertest';
import type { Express } from 'express';
import { prisma } from '../src/services/prisma.js';
import { testOutbox } from '../src/services/mailer.js';

/** Child tables first. Fixed names only; never interpolate user input into SQL. */
const TABLES = [
  'payment_allocations',
  'payments',
  'email_logs',
  'invoice_jobs',
  'invoice_items',
  'invoices',
  'invoice_sequences',
  'job_status_events',
  'transport_job_charges',
  'transport_jobs',
  'vehicles',
  'customers',
  'tenant_sequences',
  'invitations',
  'subscriptions',
  'subscription_webhook_events',
  'plans',
  'password_reset_tokens',
  'email_verification_codes',
  'audit_logs',
  'refresh_tokens',
  'memberships',
  'tenants',
  'users',
] as const;

export async function resetDb() {
  const dbName = (await prisma.$queryRawUnsafe<{ db: string }[]>('SELECT DATABASE() AS db'))[0]?.db;
  if (!dbName?.endsWith('_test')) throw new Error(`Refusing to wipe non-test database "${dbName}"`);
  for (const table of TABLES) await prisma.$executeRawUnsafe(`DELETE FROM \`${table}\``);
}

/** A cookie-keeping client that behaves like the browser app (CSRF token included). */
export async function browserClient(app: Express) {
  const agent = request.agent(app);
  const res = await agent.get('/api/v1/auth/csrf').expect(200);
  const csrf = res.body.csrfToken as string;
  return {
    agent,
    csrf,
    get: (url: string) => agent.get(url),
    post: (url: string, body?: object) => agent.post(url).set('X-CSRF-Token', csrf).send(body),
    patch: (url: string, body?: object) => agent.patch(url).set('X-CSRF-Token', csrf).send(body),
  };
}

let counter = 0;
export function uniqueEmail(prefix = 'user') {
  counter += 1;
  return `${prefix}.${Date.now()}.${counter}@test.vaharo.local`;
}

export const PASSWORD = 'Str0ng-Passw0rd!';

/**
 * Takes the newest verification code sent to `email` out of the test outbox, so tests that
 * count emails only see their own.
 */
export function takeVerificationCode(email: string): string {
  for (let i = testOutbox.length - 1; i >= 0; i--) {
    const msg = testOutbox[i]!;
    const match = /^(\d{6}) is your Vaharo verification code$/.exec(msg.subject);
    if (msg.to === email && match) {
      testOutbox.splice(i, 1);
      return match[1]!;
    }
  }
  throw new Error(`no verification code was sent to ${email}`);
}

/** Signs up with the email code, as a person would, and returns the signed-in client. */
export async function registerVerified(app: Express, email: string, name = 'Test User') {
  const client = await browserClient(app);
  const reg = await client.post('/api/v1/auth/register', { name, email, password: PASSWORD });
  if (reg.status !== 202)
    throw new Error(`register failed: ${reg.status} ${JSON.stringify(reg.body)}`);
  const res = await client.post('/api/v1/auth/verify-email', {
    email,
    code: takeVerificationCode(email),
  });
  if (res.status !== 200)
    throw new Error(`verify failed: ${res.status} ${JSON.stringify(res.body)}`);
  return { ...client, email, userId: res.body.user.id as string };
}

/** Registers a verified user and returns a signed-in client. */
export async function signedInUser(app: Express, name = 'Test User') {
  return registerVerified(app, uniqueEmail(), name);
}

/** Signed-in user who owns a new company. */
export async function ownerWithTenant(app: Express, companyName = 'Test Transport Co.') {
  const user = await signedInUser(app);
  const res = await user.post('/api/v1/tenants', { name: companyName });
  if (res.status !== 201)
    throw new Error(`create tenant failed: ${res.status} ${JSON.stringify(res.body)}`);
  return { ...user, tenantId: res.body.id as string };
}
