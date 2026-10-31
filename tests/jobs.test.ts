import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { prisma } from '../src/services/prisma.js';
import { ownerWithTenant, resetDb, signedInUser } from './helpers.js';

const app = createApp();

beforeAll(resetDb);
afterAll(() => prisma.$disconnect());

const base = (tenantId: string) => `/api/v1/tenants/${tenantId}`;
type Owner = Awaited<ReturnType<typeof ownerWithTenant>>;

async function setup(o: Owner) {
  const c = await o.post(`${base(o.tenantId)}/customers`, { name: 'ABC Ltd.' });
  const v = await o.post(`${base(o.tenantId)}/vehicles`, {
    registrationNumber: 'MH 12 AB 1234',
    vehicleType: 'HEAVY_TRUCK',
  });
  return { customerId: c.body.id as string, vehicleId: v.body.id as string };
}

function jobBody(customerId: string, extra: Record<string, unknown> = {}) {
  return {
    customerId,
    bookingDate: '2026-10-28',
    originCity: 'Mumbai',
    destinationCity: 'Pune',
    goodsDescription: 'Machine parts, 40 boxes',
    freightAmountMinor: 1_200_000,
    ...extra,
  };
}

describe('transport jobs', () => {
  it('Mumbai -> Pune: book, assign vehicle, deliver, appear in eligible-for-invoice list', async () => {
    const o = await ownerWithTenant(app);
    const { customerId, vehicleId } = await setup(o);

    const created = await o.post(
      `${base(o.tenantId)}/jobs`,
      jobBody(customerId, {
        charges: [
          { description: 'Loading', amountMinor: 50_000 },
          { description: 'Toll', amountMinor: 25_000 },
        ],
        discountAmountMinor: 10_000,
      }),
    );
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({
      jobNumber: 'JOB-0001',
      status: 'BOOKED',
      bookingDate: '2026-10-28',
      chargesTotalMinor: 75_000,
      totalMinor: 1_265_000,
      invoiceState: 'NOT_INVOICED',
    });
    const id = created.body.id as string;

    const assigned = await o.patch(`${base(o.tenantId)}/jobs/${id}`, { vehicleId });
    expect(assigned.body.vehicle.registrationNumberDisplay).toBe('MH 12 AB 1234');

    const inTransit = await o.post(`${base(o.tenantId)}/jobs/${id}/status`, {
      status: 'IN_TRANSIT',
      date: '2026-10-29',
    });
    expect(inTransit.body).toMatchObject({ status: 'IN_TRANSIT', actualPickupDate: '2026-10-29' });

    const delivered = await o.post(`${base(o.tenantId)}/jobs/${id}/status`, {
      status: 'DELIVERED',
      date: '2026-10-30',
      note: 'Signed POD received',
    });
    expect(delivered.body).toMatchObject({ status: 'DELIVERED', actualDeliveryDate: '2026-10-30' });
    expect(delivered.body.statusHistory.map((e: { toStatus: string }) => e.toStatus)).toEqual([
      'BOOKED',
      'IN_TRANSIT',
      'DELIVERED',
    ]);

    const eligible = await o.get(`${base(o.tenantId)}/jobs/eligible-for-invoice`);
    expect(eligible.body.items.map((j: { id: string }) => j.id)).toEqual([id]);

    const second = await o.post(`${base(o.tenantId)}/jobs`, jobBody(customerId));
    expect(second.body.jobNumber).toBe('JOB-0002');
  });

  it('gives unique job numbers under concurrent requests', async () => {
    const o = await ownerWithTenant(app);
    const { customerId } = await setup(o);
    const results = await Promise.all(
      Array.from({ length: 8 }, () => o.post(`${base(o.tenantId)}/jobs`, jobBody(customerId))),
    );
    expect(results.every((r) => r.status === 201)).toBe(true);
    const numbers = results.map((r) => r.body.jobNumber as string);
    expect(new Set(numbers).size).toBe(8);
  });

  it('rejects invalid status changes and edits to cancelled jobs', async () => {
    const o = await ownerWithTenant(app);
    const { customerId } = await setup(o);
    const job = await o.post(`${base(o.tenantId)}/jobs`, jobBody(customerId));
    const id = job.body.id as string;

    const cancel = await o.post(`${base(o.tenantId)}/jobs/${id}/status`, { status: 'CANCELLED' });
    expect(cancel.body.status).toBe('CANCELLED');
    const back = await o.post(`${base(o.tenantId)}/jobs/${id}/status`, { status: 'BOOKED' });
    expect(back.status).toBe(409);
    expect(back.body.error.code).toBe('INVALID_TRANSITION');
    const edit = await o.patch(`${base(o.tenantId)}/jobs/${id}`, { originCity: 'Thane' });
    expect(edit.status).toBe(409);
  });

  it('validates money, discount and required fields', async () => {
    const o = await ownerWithTenant(app);
    const { customerId } = await setup(o);
    const bad = await o.post(`${base(o.tenantId)}/jobs`, {
      customerId,
      bookingDate: '2026-02-30',
      originCity: '',
      destinationCity: 'Pune',
      goodsDescription: 'x',
      freightAmountMinor: 100.5,
    });
    expect(bad.status).toBe(400);
    expect(Object.keys(bad.body.error.fieldErrors)).toEqual(
      expect.arrayContaining(['bookingDate', 'originCity', 'freightAmountMinor']),
    );
    const discount = await o.post(
      `${base(o.tenantId)}/jobs`,
      jobBody(customerId, { discountAmountMinor: 2_000_000 }),
    );
    expect(discount.status).toBe(400);
    expect(discount.body.error.fieldErrors.discountAmountMinor).toBeDefined();
  });

  it('refuses archived customers and inactive vehicles', async () => {
    const o = await ownerWithTenant(app);
    const { customerId, vehicleId } = await setup(o);
    await o.post(`${base(o.tenantId)}/vehicles/${vehicleId}/deactivate`);
    const r1 = await o.post(`${base(o.tenantId)}/jobs`, jobBody(customerId, { vehicleId }));
    expect(r1.status).toBe(400);
    expect(r1.body.error.fieldErrors.vehicleId).toBeDefined();
    await o.post(`${base(o.tenantId)}/customers/${customerId}/archive`);
    const r2 = await o.post(`${base(o.tenantId)}/jobs`, jobBody(customerId));
    expect(r2.body.error.fieldErrors.customerId).toBeDefined();
  });

  it('filters by status, customer, invoice state and search text', async () => {
    const o = await ownerWithTenant(app);
    const { customerId, vehicleId } = await setup(o);
    const other = await o.post(`${base(o.tenantId)}/customers`, { name: 'XYZ Ltd.' });
    await o.post(`${base(o.tenantId)}/jobs`, jobBody(customerId, { vehicleId }));
    const j2 = await o.post(
      `${base(o.tenantId)}/jobs`,
      jobBody(other.body.id, { destinationCity: 'Nashik' }),
    );
    await o.post(`${base(o.tenantId)}/jobs/${j2.body.id}/status`, { status: 'DELIVERED' });

    const delivered = await o.get(`${base(o.tenantId)}/jobs?status=DELIVERED`);
    expect(delivered.body.total).toBe(1);
    const active = await o.get(`${base(o.tenantId)}/jobs?status=BOOKED,IN_TRANSIT`);
    expect(active.body.total).toBe(1);
    expect((await o.get(`${base(o.tenantId)}/jobs?q=nashik`)).body.total).toBe(1);
    expect((await o.get(`${base(o.tenantId)}/jobs?q=MH12AB`)).body.total).toBe(1);
    expect((await o.get(`${base(o.tenantId)}/jobs?q=XYZ`)).body.total).toBe(1);
    expect((await o.get(`${base(o.tenantId)}/jobs?invoiced=no`)).body.total).toBe(2);
    expect((await o.get(`${base(o.tenantId)}/jobs?status=NOPE`)).status).toBe(400);
  });
});

describe('job tenant isolation', () => {
  it("cannot use another company's customer or vehicle, or see its jobs", async () => {
    const a = await ownerWithTenant(app);
    const b = await ownerWithTenant(app);
    const aRefs = await setup(a);
    const bRefs = await setup(b);

    const withBCustomer = await a.post(`${base(a.tenantId)}/jobs`, jobBody(bRefs.customerId));
    expect(withBCustomer.status).toBe(400);
    const withBVehicle = await a.post(
      `${base(a.tenantId)}/jobs`,
      jobBody(aRefs.customerId, { vehicleId: bRefs.vehicleId }),
    );
    expect(withBVehicle.status).toBe(400);

    const bJob = await b.post(`${base(b.tenantId)}/jobs`, jobBody(bRefs.customerId));
    const id = bJob.body.id as string;
    expect((await a.get(`${base(a.tenantId)}/jobs/${id}`)).status).toBe(404);
    expect((await a.patch(`${base(a.tenantId)}/jobs/${id}`, { originCity: 'X' })).status).toBe(404);
    expect(
      (await a.post(`${base(a.tenantId)}/jobs/${id}/status`, { status: 'CANCELLED' })).status,
    ).toBe(404);
    expect((await a.get(`${base(a.tenantId)}/jobs`)).body.total).toBe(0);

    // Assigning another company's vehicle to an existing job is also refused.
    const aJob = await a.post(`${base(a.tenantId)}/jobs`, jobBody(aRefs.customerId));
    const assign = await a.patch(`${base(a.tenantId)}/jobs/${aJob.body.id}`, {
      vehicleId: bRefs.vehicleId,
    });
    expect(assign.status).toBe(400);
  });

  it('viewer cannot create jobs or change status', async () => {
    const o = await ownerWithTenant(app);
    const { customerId } = await setup(o);
    const job = await o.post(`${base(o.tenantId)}/jobs`, jobBody(customerId));
    const viewer = await signedInUser(app);
    await prisma.membership.create({
      data: { tenantId: o.tenantId, userId: viewer.userId, role: 'VIEWER' },
    });
    expect((await viewer.get(`${base(o.tenantId)}/jobs/${job.body.id}`)).status).toBe(200);
    expect((await viewer.post(`${base(o.tenantId)}/jobs`, jobBody(customerId))).status).toBe(403);
    expect(
      (
        await viewer.post(`${base(o.tenantId)}/jobs/${job.body.id}/status`, {
          status: 'IN_TRANSIT',
        })
      ).status,
    ).toBe(403);
  });
});
