import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { prisma } from '../src/services/prisma.js';
import { ownerWithTenant, resetDb, signedInUser } from './helpers.js';

const app = createApp();

beforeAll(resetDb);
afterAll(() => prisma.$disconnect());

describe('company onboarding', () => {
  it('creating a company makes the creator its Owner and records an audit entry', async () => {
    const user = await signedInUser(app);
    const res = await user.post('/api/v1/tenants', {
      name: 'Deccan Roadways Co.',
      gstin: '27abcde1234f1z5',
      stateCode: '27',
      postalCode: '411001',
      phone: '+91 98765 43210',
    });

    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      name: 'Deccan Roadways Co.',
      gstin: '27ABCDE1234F1Z5',
      phone: '+919876543210',
      currency: 'INR',
      timezone: 'Asia/Kolkata',
      myRole: 'OWNER',
    });
    expect(res.body.myPermissions).toContain('billing.manage');

    const membership = await prisma.membership.findUniqueOrThrow({
      where: { tenantId_userId: { tenantId: res.body.id, userId: user.userId } },
    });
    expect(membership.role).toBe('OWNER');
    expect(
      await prisma.auditLog.count({ where: { tenantId: res.body.id, action: 'tenant.created' } }),
    ).toBe(1);

    const me = await user.get('/api/v1/auth/me');
    expect(me.body.memberships).toEqual([
      expect.objectContaining({
        tenantId: res.body.id,
        tenantName: 'Deccan Roadways Co.',
        role: 'OWNER',
      }),
    ]);
  });

  it('validates GSTIN format and that it matches the state code', async () => {
    const user = await signedInUser(app);
    const bad = await user.post('/api/v1/tenants', { name: 'Bad GST Co.', gstin: '12345' });
    expect(bad.status).toBe(400);
    expect(bad.body.error.fieldErrors.gstin).toBeDefined();

    const mismatch = await user.post('/api/v1/tenants', {
      name: 'Mismatch Co.',
      gstin: '27ABCDE1234F1Z5',
      stateCode: '29',
    });
    expect(mismatch.status).toBe(400);
    expect(mismatch.body.error.fieldErrors.gstin).toBeDefined();
  });

  it('ignores client attempts to set server-controlled fields', async () => {
    const user = await signedInUser(app);
    const res = await user.post('/api/v1/tenants', {
      name: 'Sneaky Co.',
      status: 'ACTIVE',
      id: 'x',
    });
    expect(res.status).toBe(400); // unknown keys are rejected outright
  });

  it('requires sign-in', async () => {
    const res = await request(app).get('/api/v1/tenants');
    expect(res.status).toBe(401);
  });

  it('lists only the companies the user belongs to', async () => {
    const a = await ownerWithTenant(app, 'Company A');
    await ownerWithTenant(app, 'Company B');
    const res = await a.get('/api/v1/tenants');
    expect(res.status).toBe(200);
    expect(res.body.items.map((t: { name: string }) => t.name)).toEqual(['Company A']);
  });
});

describe('tenant isolation (cross-tenant security)', () => {
  it("a user from company A cannot read or edit company B, even with B's id", async () => {
    const a = await ownerWithTenant(app, 'Alpha Freight');
    const b = await ownerWithTenant(app, 'Beta Carriers');

    const read = await a.get(`/api/v1/tenants/${b.tenantId}`);
    expect(read.status).toBe(404);
    expect(JSON.stringify(read.body)).not.toContain('Beta Carriers');

    const edit = await a.patch(`/api/v1/tenants/${b.tenantId}`, { name: 'Hijacked' });
    expect(edit.status).toBe(404);

    const unchanged = await prisma.tenant.findUniqueOrThrow({ where: { id: b.tenantId } });
    expect(unchanged.name).toBe('Beta Carriers');

    expect((await a.get(`/api/v1/tenants/${a.tenantId}`)).status).toBe(200);
  });

  it('unknown and malformed tenant ids look the same as forbidden ones (404)', async () => {
    const a = await ownerWithTenant(app);
    expect((await a.get('/api/v1/tenants/cdoesnotexist0000000000000')).status).toBe(404);
    expect((await a.get("/api/v1/tenants/1'%20OR%201=1")).status).toBe(404);
  });

  it('a removed member loses access', async () => {
    const owner = await ownerWithTenant(app);
    const member = await signedInUser(app);
    const m = await prisma.membership.create({
      data: { tenantId: owner.tenantId, userId: member.userId, role: 'ADMIN' },
    });
    expect((await member.get(`/api/v1/tenants/${owner.tenantId}`)).status).toBe(200);

    await prisma.membership.update({ where: { id: m.id }, data: { status: 'REMOVED' } });
    expect((await member.get(`/api/v1/tenants/${owner.tenantId}`)).status).toBe(404);
  });

  it('a suspended company is not accessible', async () => {
    const owner = await ownerWithTenant(app);
    await prisma.tenant.update({ where: { id: owner.tenantId }, data: { status: 'SUSPENDED' } });
    const res = await owner.get(`/api/v1/tenants/${owner.tenantId}`);
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('TENANT_SUSPENDED');
  });
});

describe('role permissions on company settings', () => {
  it.each([
    ['VIEWER', 403],
    ['OPERATIONS', 403],
    ['ACCOUNTS', 403],
    ['ADMIN', 200],
  ] as const)('%s updating company details gets %i', async (role, expected) => {
    const owner = await ownerWithTenant(app);
    const member = await signedInUser(app);
    await prisma.membership.create({
      data: { tenantId: owner.tenantId, userId: member.userId, role },
    });

    expect((await member.get(`/api/v1/tenants/${owner.tenantId}`)).status).toBe(200);
    const res = await member.patch(`/api/v1/tenants/${owner.tenantId}`, { city: 'Nashik' });
    expect(res.status).toBe(expected);
  });

  it('owner can update details and the change is audited', async () => {
    const owner = await ownerWithTenant(app);
    const res = await owner.patch(`/api/v1/tenants/${owner.tenantId}`, {
      city: 'Pune',
      postalCode: '411001',
    });
    expect(res.status).toBe(200);
    expect(res.body.city).toBe('Pune');
    const log = await prisma.auditLog.findFirstOrThrow({
      where: { tenantId: owner.tenantId, action: 'tenant.updated' },
    });
    expect(log.metadataJson).toEqual({ fields: ['city', 'postalCode'] });
  });

  it('GSTIN/state check uses the saved record when only one side changes', async () => {
    const owner = await ownerWithTenant(app);
    await owner.patch(`/api/v1/tenants/${owner.tenantId}`, { stateCode: '27' });
    const res = await owner.patch(`/api/v1/tenants/${owner.tenantId}`, {
      gstin: '29ABCDE1234F1Z5',
    });
    expect(res.status).toBe(400);
    expect(res.body.error.fieldErrors.gstin).toBeDefined();
  });

  it('enforces the owned-company limit', async () => {
    const user = await signedInUser(app);
    for (let i = 0; i < 5; i++) {
      expect((await user.post('/api/v1/tenants', { name: `Company ${i}` })).status).toBe(201);
    }
    const res = await user.post('/api/v1/tenants', { name: 'One Too Many' });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('TENANT_LIMIT');
  });
});
