import request from 'supertest';
import type { Express } from 'express';
import { prisma } from '../src/services/prisma.js';

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

/** Registers a user and returns a signed-in client. */
export async function signedInUser(app: Express, name = 'Test User') {
  const client = await browserClient(app);
  const email = uniqueEmail();
  const res = await client.post('/api/v1/auth/register', { name, email, password: PASSWORD });
  if (res.status !== 201)
    throw new Error(`register failed: ${res.status} ${JSON.stringify(res.body)}`);
  return { ...client, email, userId: res.body.user.id as string };
}

/** Signed-in user who owns a new company. */
export async function ownerWithTenant(app: Express, companyName = 'Test Transport Co.') {
  const user = await signedInUser(app);
  const res = await user.post('/api/v1/tenants', { name: companyName });
  if (res.status !== 201)
    throw new Error(`create tenant failed: ${res.status} ${JSON.stringify(res.body)}`);
  return { ...user, tenantId: res.body.id as string };
}
