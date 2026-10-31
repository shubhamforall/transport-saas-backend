import { createHmac } from 'node:crypto';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { prisma } from '../src/services/prisma.js';
import { ownerWithTenant, resetDb, signedInUser } from './helpers.js';

// Matches RAZORPAY_WEBHOOK_SECRET in vitest.config.ts.
const WEBHOOK_SECRET = 'whsec_test_secret_value';

const app = createApp();
const base = (tenantId: string) => `/api/v1/tenants/${tenantId}`;

beforeAll(async () => {
  await resetDb();
  await prisma.plan.createMany({
    data: [
      {
        code: 'starter',
        name: 'Starter',
        priceMinor: 49_900,
        limitsJson: { maxUsers: 2, maxVehicles: 2 },
        sortOrder: 1,
        razorpayPlanId: 'plan_TESTSTARTER',
      },
      {
        code: 'growth',
        name: 'Growth',
        priceMinor: 99_900,
        limitsJson: { maxUsers: 10, maxVehicles: 25 },
        sortOrder: 2,
      },
    ],
  });
});
afterAll(() => prisma.$disconnect());

function signed(body: object, eventId: string) {
  const raw = JSON.stringify(body);
  return request(app)
    .post('/api/v1/billing/webhooks/razorpay')
    .set('Content-Type', 'application/json')
    .set('X-Razorpay-Event-Id', eventId)
    .set('X-Razorpay-Signature', createHmac('sha256', WEBHOOK_SECRET).update(raw).digest('hex'))
    .send(raw);
}

const event = (type: string, subId: string, start = 1_790_000_000, end = 1_792_592_000) => ({
  event: type,
  payload: { subscription: { entity: { id: subId, current_start: start, current_end: end } } },
});

describe('plans and trial', () => {
  it('lists active plans publicly and starts a trial for new companies', async () => {
    const plans = await request(app).get('/api/v1/plans');
    expect(plans.body.items.map((p: { code: string }) => p.code)).toEqual(['starter', 'growth']);

    const o = await ownerWithTenant(app);
    const s = await o.get(`${base(o.tenantId)}/subscription`);
    expect(s.body.subscription).toMatchObject({ status: 'TRIAL', plan: { code: 'starter' } });
    expect(s.body.access.mode).toBe('FULL');
    expect(s.body.limits).toEqual({ maxUsers: 2, maxVehicles: 2 });
  });

  it('enforces plan limits for vehicles and users', async () => {
    const o = await ownerWithTenant(app);
    const add = (n: string) =>
      o.post(`${base(o.tenantId)}/vehicles`, { registrationNumber: n, vehicleType: 'LCV' });
    expect((await add('MH01AA0001')).status).toBe(201);
    expect((await add('MH01AA0002')).status).toBe(201);
    const third = await add('MH01AA0003');
    expect(third.status).toBe(409);
    expect(third.body.error.code).toBe('PLAN_LIMIT');

    expect(
      (
        await o.post(`${base(o.tenantId)}/invitations`, {
          email: 'a1@test.vaharo.local',
          role: 'VIEWER',
        })
      ).status,
    ).toBe(201);
    const over = await o.post(`${base(o.tenantId)}/invitations`, {
      email: 'a2@test.vaharo.local',
      role: 'VIEWER',
    });
    expect(over.body.error.code).toBe('PLAN_LIMIT');
  });

  it('an ended trial makes the company read-only but data stays readable', async () => {
    const o = await ownerWithTenant(app);
    const c = await o.post(`${base(o.tenantId)}/customers`, { name: 'Keep Me Ltd.' });
    await prisma.subscription.updateMany({
      where: { tenantId: o.tenantId },
      data: { trialEndsAt: new Date(Date.now() - 1000) },
    });

    const blocked = await o.post(`${base(o.tenantId)}/customers`, { name: 'New Co' });
    expect(blocked.status).toBe(402);
    expect(blocked.body.error.code).toBe('SUBSCRIPTION_INACTIVE');
    const list = await o.get(`${base(o.tenantId)}/customers`);
    expect(list.body.items.map((x: { id: string }) => x.id)).toEqual([c.body.id]);
    const s = await o.get(`${base(o.tenantId)}/subscription`);
    expect(s.body.access).toMatchObject({
      mode: 'READ_ONLY',
      reason: 'Your free trial has ended.',
    });
  });
});

describe('Razorpay webhooks', () => {
  async function pendingCheckout() {
    const o = await ownerWithTenant(app);
    const sub = await prisma.subscription.create({
      data: {
        tenantId: o.tenantId,
        planId: (await prisma.plan.findUniqueOrThrow({ where: { code: 'growth' } })).id,
        provider: 'RAZORPAY',
        providerSubscriptionId: `sub_${Date.now()}${Math.floor(Math.random() * 1e6)}`,
        status: 'PENDING',
      },
    });
    return { o, sub };
  }

  it('a client cannot grant itself paid access; only a signed webhook does, exactly once', async () => {
    const { o, sub } = await pendingCheckout();
    // Pending checkout does not change access or limits.
    let s = await o.get(`${base(o.tenantId)}/subscription`);
    expect(s.body.subscription.status).toBe('TRIAL');
    expect(s.body.pendingCheckout.planCode).toBe('growth');

    // Unsigned / wrongly signed requests are rejected.
    const forged = await request(app)
      .post('/api/v1/billing/webhooks/razorpay')
      .set('Content-Type', 'application/json')
      .set('X-Razorpay-Event-Id', 'evt_forged')
      .set('X-Razorpay-Signature', 'deadbeef')
      .send(JSON.stringify(event('subscription.activated', sub.providerSubscriptionId!)));
    expect(forged.status).toBe(400);
    expect((await prisma.subscription.findUniqueOrThrow({ where: { id: sub.id } })).status).toBe(
      'PENDING',
    );

    const first = await signed(
      event('subscription.activated', sub.providerSubscriptionId!),
      `evt_${sub.id}_1`,
    );
    expect(first.body.result).toBe('processed');
    const dup = await signed(
      event('subscription.activated', sub.providerSubscriptionId!),
      `evt_${sub.id}_1`,
    );
    expect(dup.body.result).toBe('duplicate');

    const row = await prisma.subscription.findUniqueOrThrow({ where: { id: sub.id } });
    expect(row.status).toBe('ACTIVE');
    expect(row.currentPeriodEnd?.toISOString()).toBe(new Date(1_792_592_000 * 1000).toISOString());
    const changes = await prisma.auditLog.count({
      where: { entityId: sub.id, action: 'subscription.status_changed' },
    });
    expect(changes).toBe(1);

    s = await o.get(`${base(o.tenantId)}/subscription`);
    expect(s.body.subscription).toMatchObject({ status: 'ACTIVE', plan: { code: 'growth' } });
    expect(s.body.limits.maxVehicles).toBe(25);
  });

  it('applies cancellation and ignores unknown subscriptions and events', async () => {
    const { sub } = await pendingCheckout();
    await signed(event('subscription.activated', sub.providerSubscriptionId!), `evt_${sub.id}_a`);
    await signed(event('subscription.cancelled', sub.providerSubscriptionId!), `evt_${sub.id}_c`);
    expect((await prisma.subscription.findUniqueOrThrow({ where: { id: sub.id } })).status).toBe(
      'CANCELLED',
    );

    expect(
      (await signed(event('subscription.activated', 'sub_unknown'), 'evt_unknown')).body.result,
    ).toBe('ignored');
    expect(
      (await signed({ event: 'payment.captured', payload: {} }, 'evt_other')).body.result,
    ).toBe('ignored');
  });

  it('checkout without Razorpay keys says billing is not configured', async () => {
    const o = await ownerWithTenant(app);
    const res = await o.post(`${base(o.tenantId)}/subscription/checkout`, { planCode: 'starter' });
    expect(res.status).toBe(503);
    expect(res.body.error.code).toBe('BILLING_NOT_CONFIGURED');
  });

  it('cancelling a trial keeps access until the trial ends', async () => {
    const o = await ownerWithTenant(app);
    const res = await o.post(`${base(o.tenantId)}/subscription/cancel`);
    expect(res.body.subscription.status).toBe('CANCELLED');
    expect(res.body.access.mode).toBe('FULL');
  });
});

describe('super admin', () => {
  async function platformAdmin() {
    const admin = await signedInUser(app, 'Platform Admin');
    await prisma.user.update({ where: { id: admin.userId }, data: { isPlatformAdmin: true } });
    return admin;
  }

  it('is invisible to normal users', async () => {
    const user = await signedInUser(app);
    expect((await user.get('/api/v1/platform/tenants')).status).toBe(404);
    expect((await request(app).get('/api/v1/platform/tenants')).status).toBe(401);
  });

  it('lists tenants with subscription state, suspends and reactivates with a reason', async () => {
    const admin = await platformAdmin();
    const o = await ownerWithTenant(app, 'Suspend Me Logistics');
    const list = await admin.get('/api/v1/platform/tenants?q=Suspend');
    expect(list.body.items[0]).toMatchObject({
      name: 'Suspend Me Logistics',
      memberCount: 1,
      subscription: { status: 'TRIAL' },
    });
    expect(list.body.items[0].owners[0].email).toBe(o.email);

    expect(
      (await admin.post(`/api/v1/platform/tenants/${o.tenantId}/status`, { status: 'SUSPENDED' }))
        .status,
    ).toBe(400);
    expect(
      (
        await admin.post(`/api/v1/platform/tenants/${o.tenantId}/status`, {
          status: 'SUSPENDED',
          reason: 'Non-payment',
        })
      ).status,
    ).toBe(204);
    expect((await o.get(base(o.tenantId))).body.error.code).toBe('TENANT_SUSPENDED');
    await admin.post(`/api/v1/platform/tenants/${o.tenantId}/status`, {
      status: 'ACTIVE',
      reason: 'Paid',
    });
    expect((await o.get(base(o.tenantId))).status).toBe(200);

    const detail = await admin.get(`/api/v1/platform/tenants/${o.tenantId}`);
    expect(detail.body._count).toMatchObject({ invoices: 0 });
    expect(JSON.stringify(detail.body)).not.toMatch(/grandTotal|lineTotal/);

    const logs = await admin.get(
      `/api/v1/platform/audit-logs?tenantId=${o.tenantId}&action=platform.`,
    );
    expect(logs.body.items[0].metadata.reason).toBeDefined();
  });

  it('manages plans and sets a manual subscription', async () => {
    const admin = await platformAdmin();
    const plan = await admin.post('/api/v1/platform/plans', {
      code: 'Business',
      name: 'Business',
      priceMinor: 199_900,
      billingInterval: 'MONTHLY',
      limits: { maxUsers: 50 },
      features: ['Priority support'],
      sortOrder: 3,
    });
    expect(plan.status).toBe(201);
    expect(plan.body).toMatchObject({ code: 'business', limits: { maxUsers: 50 } });
    const upd = await admin.patch(`/api/v1/platform/plans/${plan.body.id}`, {
      priceMinor: 249_900,
      isActive: false,
    });
    expect(upd.body).toMatchObject({ priceMinor: 249_900, isActive: false });
    expect(
      (await request(app).get('/api/v1/plans')).body.items.some(
        (p: { code: string }) => p.code === 'business',
      ),
    ).toBe(false);

    const o = await ownerWithTenant(app);
    const manual = await admin.post(`/api/v1/platform/tenants/${o.tenantId}/subscription`, {
      planId: plan.body.id,
      status: 'ACTIVE',
      until: '2099-12-31',
      reason: 'Pilot customer paid by bank transfer',
    });
    expect(manual.status).toBe(201);
    const s = await o.get(`${base(o.tenantId)}/subscription`);
    expect(s.body.subscription).toMatchObject({
      status: 'ACTIVE',
      provider: 'MANUAL',
      plan: { code: 'business' },
    });
  });
});
