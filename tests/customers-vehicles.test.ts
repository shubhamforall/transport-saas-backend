import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { prisma } from '../src/services/prisma.js';
import { ownerWithTenant, resetDb, signedInUser } from './helpers.js';

const app = createApp();

beforeAll(resetDb);
afterAll(() => prisma.$disconnect());

const base = (tenantId: string) => `/api/v1/tenants/${tenantId}`;

describe('customers', () => {
  it('creates, lists, searches, edits, archives and restores a customer', async () => {
    const o = await ownerWithTenant(app);
    const created = await o.post(`${base(o.tenantId)}/customers`, {
      name: 'ABC Manufacturing Pvt. Ltd.',
      email: 'Accounts@ABC.example',
      phone: '+91 98765 43210',
      gstin: '27aaacb1234c1z5',
      stateCode: '27',
      city: 'Pune',
      paymentTermsDays: 30,
    });
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({
      customerType: 'BUSINESS',
      email: 'accounts@abc.example',
      phone: '+919876543210',
      gstin: '27AAACB1234C1Z5',
      status: 'ACTIVE',
    });
    const id = created.body.id as string;

    await o.post(`${base(o.tenantId)}/customers`, { name: 'XYZ Ltd.', customerType: 'BUSINESS' });

    const search = await o.get(`${base(o.tenantId)}/customers?q=abc`);
    expect(search.body.items.map((c: { name: string }) => c.name)).toEqual([
      'ABC Manufacturing Pvt. Ltd.',
    ]);
    const byPhone = await o.get(`${base(o.tenantId)}/customers?q=98765`);
    expect(byPhone.body.total).toBe(1);

    const edit = await o.patch(`${base(o.tenantId)}/customers/${id}`, { city: 'Mumbai' });
    expect(edit.body.city).toBe('Mumbai');

    const archived = await o.post(`${base(o.tenantId)}/customers/${id}/archive`);
    expect(archived.body.status).toBe('ARCHIVED');
    expect((await o.get(`${base(o.tenantId)}/customers`)).body.total).toBe(1);
    expect((await o.get(`${base(o.tenantId)}/customers?status=ALL`)).body.total).toBe(2);

    const restored = await o.post(`${base(o.tenantId)}/customers/${id}/restore`);
    expect(restored.body.status).toBe('ACTIVE');

    const actions = await prisma.auditLog.findMany({
      where: { tenantId: o.tenantId, entityId: id },
      select: { action: true },
      orderBy: { createdAt: 'asc' },
    });
    expect(actions.map((a) => a.action)).toEqual([
      'customer.created',
      'customer.updated',
      'customer.archived',
      'customer.restored',
    ]);
  });

  it('paginates with a stable page size', async () => {
    const o = await ownerWithTenant(app);
    for (let i = 0; i < 5; i++) {
      await o.post(`${base(o.tenantId)}/customers`, { name: `Customer ${i}` });
    }
    const page = await o.get(`${base(o.tenantId)}/customers?pageSize=2&page=2&sort=name&order=asc`);
    expect(page.body).toMatchObject({ page: 2, pageSize: 2, total: 5, totalPages: 3 });
    expect(page.body.items.map((c: { name: string }) => c.name)).toEqual([
      'Customer 2',
      'Customer 3',
    ]);
  });

  it('rejects unknown sort fields and invalid data', async () => {
    const o = await ownerWithTenant(app);
    expect((await o.get(`${base(o.tenantId)}/customers?sort=password`)).status).toBe(400);
    const bad = await o.post(`${base(o.tenantId)}/customers`, {
      name: 'X',
      email: 'nope',
      gstin: 'bad',
      postalCode: '12',
    });
    expect(bad.status).toBe(400);
    expect(Object.keys(bad.body.error.fieldErrors)).toEqual(
      expect.arrayContaining(['name', 'email', 'gstin', 'postalCode']),
    );
  });

  it('company A cannot read, edit or archive company B customers', async () => {
    const a = await ownerWithTenant(app, 'A Co');
    const b = await ownerWithTenant(app, 'B Co');
    const bc = await b.post(`${base(b.tenantId)}/customers`, { name: 'Secret Customer' });
    const id = bc.body.id as string;

    // Using A's own tenant id with B's customer id.
    expect((await a.get(`${base(a.tenantId)}/customers/${id}`)).status).toBe(404);
    expect((await a.patch(`${base(a.tenantId)}/customers/${id}`, { name: 'Hacked' })).status).toBe(
      404,
    );
    expect((await a.post(`${base(a.tenantId)}/customers/${id}/archive`)).status).toBe(404);
    // Using B's tenant id directly.
    expect((await a.get(`${base(b.tenantId)}/customers`)).status).toBe(404);

    const still = await prisma.customer.findUniqueOrThrow({ where: { id } });
    expect(still).toMatchObject({ name: 'Secret Customer', status: 'ACTIVE' });
    expect((await a.get(`${base(a.tenantId)}/customers?q=Secret`)).body.total).toBe(0);
  });

  it('viewers can read but not change customers', async () => {
    const o = await ownerWithTenant(app);
    const viewer = await signedInUser(app);
    await prisma.membership.create({
      data: { tenantId: o.tenantId, userId: viewer.userId, role: 'VIEWER' },
    });
    expect((await viewer.get(`${base(o.tenantId)}/customers`)).status).toBe(200);
    expect((await viewer.post(`${base(o.tenantId)}/customers`, { name: 'Nope Co' })).status).toBe(
      403,
    );
  });
});

describe('vehicles', () => {
  it('normalises registration numbers and keeps them unique per company', async () => {
    const o = await ownerWithTenant(app);
    const v = await o.post(`${base(o.tenantId)}/vehicles`, {
      registrationNumber: ' mh 12-ab   1234 ',
      vehicleType: 'HEAVY_TRUCK',
      capacityMilli: 10_500,
      capacityUnit: 'TONNES',
      ownershipType: 'OWNED',
    });
    expect(v.status).toBe(201);
    expect(v.body).toMatchObject({
      registrationNumberDisplay: 'MH 12-AB 1234',
      registrationNumberNormalized: 'MH12AB1234',
      status: 'ACTIVE',
    });

    const dup = await o.post(`${base(o.tenantId)}/vehicles`, {
      registrationNumber: 'MH12AB1234',
      vehicleType: 'LCV',
    });
    expect(dup.status).toBe(409);
    expect(dup.body.error.fieldErrors.registrationNumber).toBeDefined();

    // Another company may register the same number.
    const other = await ownerWithTenant(app);
    const same = await other.post(`${base(other.tenantId)}/vehicles`, {
      registrationNumber: 'MH 12 AB 1234',
      vehicleType: 'LCV',
    });
    expect(same.status).toBe(201);

    expect((await o.get(`${base(o.tenantId)}/vehicles?q=mh12ab`)).body.total).toBe(1);
    expect((await o.get(`${base(o.tenantId)}/vehicles?q=MH 12`)).body.total).toBe(1);
  });

  it('deactivates and re-activates, and rejects invalid registrations', async () => {
    const o = await ownerWithTenant(app);
    const v = await o.post(`${base(o.tenantId)}/vehicles`, {
      registrationNumber: 'KA01AB0001',
      vehicleType: 'LCV',
    });
    const id = v.body.id as string;
    expect((await o.post(`${base(o.tenantId)}/vehicles/${id}/deactivate`)).body.status).toBe(
      'INACTIVE',
    );
    expect((await o.get(`${base(o.tenantId)}/vehicles`)).body.total).toBe(0);
    expect((await o.post(`${base(o.tenantId)}/vehicles/${id}/activate`)).body.status).toBe(
      'ACTIVE',
    );

    const bad = await o.post(`${base(o.tenantId)}/vehicles`, {
      registrationNumber: '###',
      vehicleType: 'LCV',
    });
    expect(bad.status).toBe(400);
  });

  it('company A cannot touch company B vehicles', async () => {
    const a = await ownerWithTenant(app);
    const b = await ownerWithTenant(app);
    const bv = await b.post(`${base(b.tenantId)}/vehicles`, {
      registrationNumber: 'GJ01ZZ9999',
      vehicleType: 'TRAILER',
    });
    const id = bv.body.id as string;
    expect((await a.get(`${base(a.tenantId)}/vehicles/${id}`)).status).toBe(404);
    expect(
      (await a.patch(`${base(a.tenantId)}/vehicles/${id}`, { makeModel: 'Hacked' })).status,
    ).toBe(404);
    expect((await a.post(`${base(a.tenantId)}/vehicles/${id}/deactivate`)).status).toBe(404);
    expect((await prisma.vehicle.findUniqueOrThrow({ where: { id } })).status).toBe('ACTIVE');
  });

  it('accounts role cannot add vehicles', async () => {
    const o = await ownerWithTenant(app);
    const acc = await signedInUser(app);
    await prisma.membership.create({
      data: { tenantId: o.tenantId, userId: acc.userId, role: 'ACCOUNTS' },
    });
    const res = await acc.post(`${base(o.tenantId)}/vehicles`, {
      registrationNumber: 'MH01AA0001',
      vehicleType: 'LCV',
    });
    expect(res.status).toBe(403);
  });
});
