import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { prisma } from '../src/services/prisma.js';
import { ownerWithTenant, resetDb, signedInUser } from './helpers.js';

const app = createApp();

beforeAll(resetDb);
afterAll(() => prisma.$disconnect());

const base = (tenantId: string) => `/api/v1/tenants/${tenantId}`;
type Owner = Awaited<ReturnType<typeof ownerWithTenant>>;

/** Company with address, GSTIN and 18% default GST, a customer and a delivered job. */
async function readyCompany(opts: { customerState?: string } = {}) {
  const o = await ownerWithTenant(app, 'Deccan Roadways Co.');
  await o.patch(base(o.tenantId), {
    addressLine1: 'Plot 12, MIDC',
    city: 'Pune',
    stateCode: '27',
    state: 'Maharashtra',
    gstin: '27ABCDE1234F1Z5',
    defaultTaxRateBps: 1800,
    defaultSacCode: '996511',
    paymentInstructions: 'UPI: deccan@bank',
  });
  const c = await o.post(`${base(o.tenantId)}/customers`, {
    name: 'ABC Ltd.',
    stateCode: opts.customerState ?? '27',
    addressLine1: 'Andheri East',
    city: 'Mumbai',
    paymentTermsDays: 15,
  });
  const v = await o.post(`${base(o.tenantId)}/vehicles`, {
    registrationNumber: 'MH12AB1234',
    vehicleType: 'HEAVY_TRUCK',
  });
  return { o, customerId: c.body.id as string, vehicleId: v.body.id as string };
}

async function deliveredJob(o: Owner, customerId: string, vehicleId?: string) {
  const job = await o.post(`${base(o.tenantId)}/jobs`, {
    customerId,
    vehicleId,
    bookingDate: '2026-10-28',
    originCity: 'Mumbai',
    destinationCity: 'Pune',
    goodsDescription: 'Machine parts',
    lrNumber: 'LR-77',
    freightAmountMinor: 1_200_000,
    charges: [{ description: 'Loading', amountMinor: 100_000 }],
    discountAmountMinor: 50_000,
  });
  await o.post(`${base(o.tenantId)}/jobs/${job.body.id}/status`, {
    status: 'DELIVERED',
    date: '2026-10-30',
  });
  return job.body.id as string;
}

describe('job to invoice (Mumbai -> Pune)', () => {
  it('prefills from the job, issues with a unique number and locks the job', async () => {
    const { o, customerId, vehicleId } = await readyCompany();
    const jobId = await deliveredJob(o, customerId, vehicleId);

    const draft = await o.post(`${base(o.tenantId)}/invoices`, {
      jobIds: [jobId],
      invoiceDate: '2026-10-31',
    });
    expect(draft.status).toBe(201);
    expect(draft.body).toMatchObject({
      status: 'DRAFT',
      invoiceNumber: null,
      taxType: 'INTRA_STATE',
      placeOfSupplyStateCode: '27',
      dueDate: '2026-11-15', // customer terms: 15 days
      customer: { name: 'ABC Ltd.' },
    });
    expect(draft.body.items).toHaveLength(2);
    expect(draft.body.items[0].description).toContain('Mumbai to Pune');
    expect(draft.body.items[0].description).toContain('MH12AB1234');
    expect(draft.body.items[0]).toMatchObject({
      sacCode: '996511',
      taxRateBps: 1800,
      discountMinor: 50_000,
    });
    // (12,000 - 500 + 1,000) = 12,500 taxable; 9% + 9% = 2,250
    expect(draft.body).toMatchObject({
      subtotalMinor: 1_300_000,
      discountMinor: 50_000,
      taxableMinor: 1_250_000,
      cgstMinor: 112_500,
      sgstMinor: 112_500,
      grandTotalMinor: 1_475_000,
    });
    expect(draft.body.jobs[0]).toMatchObject({ id: jobId, vehicleRegistration: 'MH12AB1234' });

    // The job is reserved and no longer eligible.
    const eligible = await o.get(`${base(o.tenantId)}/jobs/eligible-for-invoice`);
    expect(eligible.body.items).toHaveLength(0);
    const job = await o.get(`${base(o.tenantId)}/jobs/${jobId}`);
    expect(job.body.invoiceState).toBe('IN_DRAFT');

    const issued = await o.post(`${base(o.tenantId)}/invoices/${draft.body.id}/issue`);
    expect(issued.status).toBe(200);
    expect(issued.body).toMatchObject({
      status: 'ISSUED',
      invoiceNumber: 'INV/26-27/0001',
      balanceMinor: 1_475_000,
      billTo: { name: 'ABC Ltd.', city: 'Mumbai' },
      from: { name: 'Deccan Roadways Co.', gstin: '27ABCDE1234F1Z5' },
    });
    expect((await o.get(`${base(o.tenantId)}/jobs/${jobId}`)).body.invoiceState).toBe('INVOICED');

    // Finalised invoices cannot be silently changed or deleted.
    const edit = await o.patch(`${base(o.tenantId)}/invoices/${draft.body.id}`, { notes: 'x' });
    expect(edit.status).toBe(409);
    expect(
      (
        await o.agent
          .delete(`${base(o.tenantId)}/invoices/${draft.body.id}`)
          .set('X-CSRF-Token', o.csrf)
      ).status,
    ).toBe(409);

    // Snapshot: later customer edits do not change the issued invoice.
    await o.patch(`${base(o.tenantId)}/customers/${customerId}`, { name: 'ABC Renamed Ltd.' });
    const again = await o.get(`${base(o.tenantId)}/invoices/${draft.body.id}`);
    expect(again.body.billTo.name).toBe('ABC Ltd.');

    // A second invoice for the same job is refused.
    const dup = await o.post(`${base(o.tenantId)}/invoices`, { jobIds: [jobId] });
    expect(dup.status).toBe(409);
    expect(dup.body.error.code).toBe('JOB_ALREADY_INVOICED');
  });

  it('uses IGST for a customer in another state', async () => {
    const { o, customerId } = await readyCompany({ customerState: '29' });
    const jobId = await deliveredJob(o, customerId);
    const draft = await o.post(`${base(o.tenantId)}/invoices`, { jobIds: [jobId] });
    expect(draft.body).toMatchObject({ taxType: 'INTER_STATE', igstMinor: 225_000, cgstMinor: 0 });
  });
});

describe('invoice integrity under concurrency', () => {
  it('parallel issue requests give exactly one number', async () => {
    const { o, customerId } = await readyCompany();
    const draft = await o.post(`${base(o.tenantId)}/invoices`, {
      customerId,
      items: [
        { description: 'Freight', quantityMilli: 1000, unitPriceMinor: 500_000, taxRateBps: 1800 },
      ],
    });
    const results = await Promise.all(
      Array.from({ length: 6 }, () =>
        o.post(`${base(o.tenantId)}/invoices/${draft.body.id}/issue`),
      ),
    );
    expect(results.every((r) => r.status === 200)).toBe(true);
    expect(new Set(results.map((r) => r.body.invoiceNumber)).size).toBe(1);
    const seq = await prisma.invoiceSequence.findFirstOrThrow({ where: { tenantId: o.tenantId } });
    expect(seq.nextNumber).toBe(2);
  });

  it('issuing many invoices at once gives unique consecutive numbers', async () => {
    const { o, customerId } = await readyCompany();
    const drafts = await Promise.all(
      Array.from({ length: 5 }, () =>
        o.post(`${base(o.tenantId)}/invoices`, {
          customerId,
          items: [{ description: 'Freight', quantityMilli: 1000, unitPriceMinor: 100_000 }],
        }),
      ),
    );
    const issued = await Promise.all(
      drafts.map((d) => o.post(`${base(o.tenantId)}/invoices/${d.body.id}/issue`)),
    );
    const numbers = issued.map((r) => r.body.invoiceNumber as string).sort();
    expect(numbers).toEqual(
      [1, 2, 3, 4, 5].map((n) => `INV/26-27/000${n}`.replace('26-27', numbers[0]!.split('/')[1]!)),
    );
  });

  it('two drafts racing for the same job: only one wins', async () => {
    const { o, customerId } = await readyCompany();
    const jobId = await deliveredJob(o, customerId);
    const results = await Promise.all(
      Array.from({ length: 4 }, () => o.post(`${base(o.tenantId)}/invoices`, { jobIds: [jobId] })),
    );
    expect(results.filter((r) => r.status === 201)).toHaveLength(1);
    expect(
      results
        .filter((r) => r.status === 409)
        .every((r) => r.body.error.code === 'JOB_ALREADY_INVOICED'),
    ).toBe(true);
    expect(await prisma.invoiceJob.count({ where: { transportJobId: jobId } })).toBe(1);
  });
});

describe('manual invoices, validation and cancellation', () => {
  it('creates a manual invoice without any job; client totals are ignored', async () => {
    const { o, customerId } = await readyCompany();
    const tampered = await o.post(`${base(o.tenantId)}/invoices`, {
      customerId,
      items: [{ description: 'Warehousing', quantityMilli: 2500, unitPriceMinor: 40_000 }],
      grandTotalMinor: 1,
    });
    expect(tampered.status).toBe(400); // unknown field rejected

    const manual = await o.post(`${base(o.tenantId)}/invoices`, {
      customerId,
      taxType: 'NONE',
      items: [{ description: 'Warehousing', quantityMilli: 2500, unitPriceMinor: 40_000 }],
    });
    expect(manual.status).toBe(201);
    expect(manual.body).toMatchObject({ grandTotalMinor: 100_000, jobs: [] });

    const updated = await o.patch(`${base(o.tenantId)}/invoices/${manual.body.id}`, {
      items: [
        { description: 'Warehousing', quantityMilli: 1000, unitPriceMinor: 40_000 },
        {
          description: 'Handling',
          quantityMilli: 1000,
          unitPriceMinor: 10_000,
          discountMinor: 5_000,
        },
      ],
    });
    expect(updated.body).toMatchObject({ grandTotalMinor: 45_000, discountMinor: 5_000 });

    const del = await o.agent
      .delete(`${base(o.tenantId)}/invoices/${manual.body.id}`)
      .set('X-CSRF-Token', o.csrf);
    expect(del.status).toBe(204);
  });

  it('refuses to issue until company details are complete', async () => {
    const o = await ownerWithTenant(app);
    const c = await o.post(`${base(o.tenantId)}/customers`, { name: 'Walk-in' });
    const draft = await o.post(`${base(o.tenantId)}/invoices`, {
      customerId: c.body.id,
      items: [{ description: 'Freight', quantityMilli: 1000, unitPriceMinor: 100 }],
    });
    const res = await o.post(`${base(o.tenantId)}/invoices/${draft.body.id}/issue`);
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('INVOICE_INCOMPLETE');
    expect(res.body.error.fieldErrors.company).toBeDefined();
    const still = await prisma.invoice.findUniqueOrThrow({ where: { id: draft.body.id } });
    expect(still).toMatchObject({ status: 'DRAFT', invoiceNumber: null });
  });

  it('cancelling needs a reason and makes the job billable again', async () => {
    const { o, customerId } = await readyCompany();
    const jobId = await deliveredJob(o, customerId);
    const draft = await o.post(`${base(o.tenantId)}/invoices`, { jobIds: [jobId] });
    await o.post(`${base(o.tenantId)}/invoices/${draft.body.id}/issue`);

    expect((await o.post(`${base(o.tenantId)}/invoices/${draft.body.id}/cancel`, {})).status).toBe(
      400,
    );
    const cancelled = await o.post(`${base(o.tenantId)}/invoices/${draft.body.id}/cancel`, {
      reason: 'Wrong freight amount',
    });
    expect(cancelled.body).toMatchObject({
      status: 'CANCELLED',
      balanceMinor: 0,
      cancellationReason: 'Wrong freight amount',
    });
    expect(cancelled.body.invoiceNumber).toMatch(/^INV\//); // number is kept, never reused

    const eligible = await o.get(`${base(o.tenantId)}/jobs/eligible-for-invoice`);
    expect(eligible.body.items.map((j: { id: string }) => j.id)).toEqual([jobId]);
    const rebill = await o.post(`${base(o.tenantId)}/invoices`, { jobIds: [jobId] });
    expect(rebill.status).toBe(201);
  });

  it('lists with status and search filters', async () => {
    const { o, customerId } = await readyCompany();
    const d1 = await o.post(`${base(o.tenantId)}/invoices`, {
      customerId,
      items: [{ description: 'A', quantityMilli: 1000, unitPriceMinor: 100 }],
    });
    await o.post(`${base(o.tenantId)}/invoices`, {
      customerId,
      items: [{ description: 'B', quantityMilli: 1000, unitPriceMinor: 100 }],
    });
    await o.post(`${base(o.tenantId)}/invoices/${d1.body.id}/issue`);
    expect((await o.get(`${base(o.tenantId)}/invoices?status=DRAFT`)).body.total).toBe(1);
    expect((await o.get(`${base(o.tenantId)}/invoices?status=ISSUED`)).body.total).toBe(1);
    expect((await o.get(`${base(o.tenantId)}/invoices?q=0001`)).body.total).toBe(1);
    expect((await o.get(`${base(o.tenantId)}/invoices?q=ABC`)).body.total).toBe(2);
  });
});

describe('invoice PDF', () => {
  it('returns a PDF built from saved data', async () => {
    const { o, customerId } = await readyCompany();
    const jobId = await deliveredJob(o, customerId);
    const draft = await o.post(`${base(o.tenantId)}/invoices`, { jobIds: [jobId] });
    await o.post(`${base(o.tenantId)}/invoices/${draft.body.id}/issue`);
    const pdf = await o.agent
      .get(`${base(o.tenantId)}/invoices/${draft.body.id}/pdf`)
      .buffer(true)
      .parse((res, cb) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => cb(null, Buffer.concat(chunks)));
      });
    expect(pdf.status).toBe(200);
    expect(pdf.headers['content-type']).toBe('application/pdf');
    expect(pdf.headers['content-disposition']).toContain('INV-26-27-0001.pdf');
    expect((pdf.body as Buffer).subarray(0, 5).toString()).toBe('%PDF-');
    expect((pdf.body as Buffer).length).toBeGreaterThan(5_000);
  });
});

describe('invoice security', () => {
  it("company A cannot read, issue, cancel or download company B's invoice, or bill B's job", async () => {
    const a = await readyCompany();
    const b = await readyCompany();
    const bJob = await deliveredJob(b.o, b.customerId);
    const bInv = await b.o.post(`${base(b.o.tenantId)}/invoices`, { jobIds: [bJob] });
    const id = bInv.body.id as string;
    const A = a.o;
    expect((await A.get(`${base(A.tenantId)}/invoices/${id}`)).status).toBe(404);
    expect((await A.post(`${base(A.tenantId)}/invoices/${id}/issue`)).status).toBe(404);
    expect((await A.patch(`${base(A.tenantId)}/invoices/${id}`, { notes: 'x' })).status).toBe(404);
    expect(
      (await A.post(`${base(A.tenantId)}/invoices/${id}/cancel`, { reason: 'abc' })).status,
    ).toBe(404);
    expect((await A.get(`${base(A.tenantId)}/invoices/${id}/pdf`)).status).toBe(404);
    const steal = await A.post(`${base(A.tenantId)}/invoices`, { jobIds: [bJob] });
    expect(steal.status).toBe(400);
    const otherCustomer = await A.post(`${base(A.tenantId)}/invoices`, {
      customerId: b.customerId,
      items: [{ description: 'x', quantityMilli: 1000, unitPriceMinor: 1 }],
    });
    expect(otherCustomer.status).toBe(400);
    expect((await prisma.invoice.findUniqueOrThrow({ where: { id } })).status).toBe('DRAFT');
  });

  it('operations can view but not create invoices; accounts can create', async () => {
    const { o, customerId } = await readyCompany();
    const ops = await signedInUser(app);
    const acc = await signedInUser(app);
    await prisma.membership.createMany({
      data: [
        { tenantId: o.tenantId, userId: ops.userId, role: 'OPERATIONS' },
        { tenantId: o.tenantId, userId: acc.userId, role: 'ACCOUNTS' },
      ],
    });
    const body = {
      customerId,
      items: [{ description: 'x', quantityMilli: 1000, unitPriceMinor: 100 }],
    };
    expect((await ops.get(`${base(o.tenantId)}/invoices`)).status).toBe(200);
    expect((await ops.post(`${base(o.tenantId)}/invoices`, body)).status).toBe(403);
    expect((await acc.post(`${base(o.tenantId)}/invoices`, body)).status).toBe(201);
  });
});
