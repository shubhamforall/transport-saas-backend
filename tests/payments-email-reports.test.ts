import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { prisma } from '../src/services/prisma.js';
import { testOutbox } from '../src/services/mailer.js';
import { todayIn } from '../src/utils/fields.js';
import { PASSWORD, browserClient, ownerWithTenant, resetDb, signedInUser } from './helpers.js';

const app = createApp();

beforeAll(resetDb);
beforeEach(() => {
  testOutbox.length = 0;
});
afterAll(() => prisma.$disconnect());

const base = (tenantId: string) => `/api/v1/tenants/${tenantId}`;
const today = todayIn('Asia/Kolkata');

async function issuedInvoice(
  amountMinor = 1_000_000,
  customerEmail: string | undefined = 'accounts@abc.example',
) {
  const o = await ownerWithTenant(app);
  await o.patch(base(o.tenantId), { addressLine1: 'MIDC', city: 'Pune', stateCode: '27' });
  const c = await o.post(`${base(o.tenantId)}/customers`, {
    name: 'ABC Ltd.',
    email: customerEmail,
    stateCode: '27',
  });
  const draft = await o.post(`${base(o.tenantId)}/invoices`, {
    customerId: c.body.id,
    invoiceDate: today,
    taxType: 'NONE',
    items: [
      { description: 'Freight Mumbai to Pune', quantityMilli: 1000, unitPriceMinor: amountMinor },
    ],
  });
  const inv = await o.post(`${base(o.tenantId)}/invoices/${draft.body.id}/issue`);
  return { o, invoiceId: inv.body.id as string, customerId: c.body.id as string };
}

const pay = (amountMinor: number, invoiceId: string, extra: object = {}) => ({
  invoiceId,
  paymentDate: today,
  amountMinor,
  method: 'UPI',
  reference: 'UTR123',
  ...extra,
});

describe('payments', () => {
  it('records partial then full payment and tracks the balance', async () => {
    const { o, invoiceId } = await issuedInvoice(1_000_000);
    const p1 = await o.post(`${base(o.tenantId)}/payments`, pay(400_000, invoiceId));
    expect(p1.status).toBe(201);
    expect(p1.body.allocations[0]).toMatchObject({ invoiceId, allocatedAmountMinor: 400_000 });

    let inv = await o.get(`${base(o.tenantId)}/invoices/${invoiceId}`);
    expect(inv.body).toMatchObject({
      status: 'PARTIALLY_PAID',
      amountPaidMinor: 400_000,
      balanceMinor: 600_000,
    });
    expect(inv.body.payments).toHaveLength(1);

    const over = await o.post(`${base(o.tenantId)}/payments`, pay(700_000, invoiceId));
    expect(over.status).toBe(400);
    expect(over.body.error.code).toBe('OVER_ALLOCATION');

    await o.post(
      `${base(o.tenantId)}/payments`,
      pay(600_000, invoiceId, { method: 'BANK_TRANSFER' }),
    );
    inv = await o.get(`${base(o.tenantId)}/invoices/${invoiceId}`);
    expect(inv.body).toMatchObject({ status: 'PAID', balanceMinor: 0 });

    // Paid invoices cannot be cancelled without voiding payments first.
    const cancel = await o.post(`${base(o.tenantId)}/invoices/${invoiceId}/cancel`, {
      reason: 'test',
    });
    expect(cancel.status).toBe(409);

    const voided = await o.post(`${base(o.tenantId)}/payments/${p1.body.id}/void`, {
      reason: 'Cheque bounced',
    });
    expect(voided.body.status).toBe('VOIDED');
    inv = await o.get(`${base(o.tenantId)}/invoices/${invoiceId}`);
    expect(inv.body).toMatchObject({
      status: 'PARTIALLY_PAID',
      amountPaidMinor: 600_000,
      balanceMinor: 400_000,
    });
    expect(
      (await o.post(`${base(o.tenantId)}/payments/${p1.body.id}/void`, { reason: 'again' })).status,
    ).toBe(409);

    const list = await o.get(`${base(o.tenantId)}/payments`);
    expect(list.body.total).toBe(1);
    expect((await o.get(`${base(o.tenantId)}/payments?status=ALL`)).body.total).toBe(2);
  });

  it('concurrent payments can never over-pay an invoice', async () => {
    const { o, invoiceId } = await issuedInvoice(1_000_000);
    const results = await Promise.all(
      Array.from({ length: 5 }, () =>
        o.post(`${base(o.tenantId)}/payments`, pay(400_000, invoiceId)),
      ),
    );
    expect(results.filter((r) => r.status === 201)).toHaveLength(2);
    const inv = await prisma.invoice.findUniqueOrThrow({ where: { id: invoiceId } });
    expect(inv.amountPaidMinor).toBe(800_000);
    expect(await prisma.payment.count({ where: { tenantId: o.tenantId } })).toBe(2);
  });

  it("refuses payments on drafts and on other companies' invoices", async () => {
    const a = await issuedInvoice();
    const b = await issuedInvoice();
    const steal = await a.o.post(`${base(a.o.tenantId)}/payments`, pay(100, b.invoiceId));
    expect(steal.status).toBe(400);
    const draft = await a.o.post(`${base(a.o.tenantId)}/invoices`, {
      customerId: a.customerId,
      items: [{ description: 'x', quantityMilli: 1000, unitPriceMinor: 100 }],
    });
    expect((await a.o.post(`${base(a.o.tenantId)}/payments`, pay(100, draft.body.id))).status).toBe(
      409,
    );

    const bPay = await b.o.post(`${base(b.o.tenantId)}/payments`, pay(100, b.invoiceId));
    expect((await a.o.get(`${base(a.o.tenantId)}/payments/${bPay.body.id}`)).status).toBe(404);
    expect(
      (await a.o.post(`${base(a.o.tenantId)}/payments/${bPay.body.id}/void`, { reason: 'abc' }))
        .status,
    ).toBe(404);
  });

  it('operations role cannot record payments', async () => {
    const { o, invoiceId } = await issuedInvoice();
    const ops = await signedInUser(app);
    await prisma.membership.create({
      data: { tenantId: o.tenantId, userId: ops.userId, role: 'OPERATIONS' },
    });
    expect((await ops.post(`${base(o.tenantId)}/payments`, pay(100, invoiceId))).status).toBe(403);
    expect((await ops.get(`${base(o.tenantId)}/payments`)).status).toBe(403);
  });
});

describe('invoice email', () => {
  it('emails the issued invoice with its PDF and logs the attempt', async () => {
    const { o, invoiceId } = await issuedInvoice();
    const res = await o.post(`${base(o.tenantId)}/invoices/${invoiceId}/email`, {
      message: 'Please pay soon.',
    });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      status: 'SENT',
      recipient: 'accounts@abc.example',
      attemptCount: 1,
    });

    expect(testOutbox).toHaveLength(1);
    const mail = testOutbox[0]!;
    expect(mail.subject).toMatch(/^Invoice INV\/\d\d-\d\d\/0001 from /);
    expect(mail.text).toContain('Please pay soon.');
    expect(mail.attachments?.[0]?.contentType).toBe('application/pdf');
    expect(mail.attachments?.[0]?.content.subarray(0, 5).toString()).toBe('%PDF-');

    const logs = await o.get(`${base(o.tenantId)}/invoices/${invoiceId}/email-logs`);
    expect(logs.body.items).toHaveLength(1);
    const inv = await o.get(`${base(o.tenantId)}/invoices/${invoiceId}`);
    expect(inv.body.lastEmailedAt).toBeTruthy();
    expect(inv.body.invoiceNumber).toMatch(/0001$/); // re-sending never creates a new invoice
  });

  it('needs a recipient and refuses drafts', async () => {
    const { o, invoiceId, customerId } = await issuedInvoice(1000, '');
    const noEmail = await o.post(`${base(o.tenantId)}/invoices/${invoiceId}/email`, {});
    expect(noEmail.status).toBe(400);
    expect(noEmail.body.error.fieldErrors.to).toBeDefined();
    const ok = await o.post(`${base(o.tenantId)}/invoices/${invoiceId}/email`, {
      to: 'boss@abc.example',
    });
    expect(ok.status).toBe(200);

    const draft = await o.post(`${base(o.tenantId)}/invoices`, {
      customerId,
      items: [{ description: 'x', quantityMilli: 1000, unitPriceMinor: 100 }],
    });
    expect(
      (await o.post(`${base(o.tenantId)}/invoices/${draft.body.id}/email`, { to: 'a@b.co' }))
        .status,
    ).toBe(409);
  });

  it('blocks a second send while one is in progress (double click)', async () => {
    const { o, invoiceId } = await issuedInvoice();
    await prisma.emailLog.create({
      data: {
        tenantId: o.tenantId,
        invoiceId,
        kind: 'invoice',
        recipient: 'x@y.z',
        subject: 's',
        status: 'SENDING',
      },
    });
    const res = await o.post(`${base(o.tenantId)}/invoices/${invoiceId}/email`, {});
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('EMAIL_IN_PROGRESS');
  });
});

describe('password reset', () => {
  it('emails a single-use link, sets the new password and signs out other sessions', async () => {
    const user = await signedInUser(app);
    const client = await browserClient(app);
    const res = await client.post('/api/v1/auth/forgot-password', { email: user.email });
    expect(res.status).toBe(202);
    expect(testOutbox).toHaveLength(1);
    const token = /token=([^\s&]+)/.exec(testOutbox[0]!.text)![1]!;

    const unknown = await client.post('/api/v1/auth/forgot-password', {
      email: 'nobody@example.com',
    });
    expect(unknown.status).toBe(202);
    expect(unknown.body.message).toBe(res.body.message);
    expect(testOutbox).toHaveLength(1);

    const reset = await client.post('/api/v1/auth/reset-password', {
      token: decodeURIComponent(token),
      password: 'Brand-New-Pass1',
    });
    expect(reset.status).toBe(204);

    // Old session is gone, old password fails, new password works, link cannot be reused.
    expect((await user.post('/api/v1/auth/refresh')).status).toBe(401);
    const old = await (
      await browserClient(app)
    ).post('/api/v1/auth/login', { email: user.email, password: PASSWORD });
    expect(old.status).toBe(401);
    const fresh = await (
      await browserClient(app)
    ).post('/api/v1/auth/login', { email: user.email, password: 'Brand-New-Pass1' });
    expect(fresh.status).toBe(200);
    const reuse = await client.post('/api/v1/auth/reset-password', {
      token: decodeURIComponent(token),
      password: 'Another-Pass-2',
    });
    expect(reuse.status).toBe(400);
    expect(reuse.body.error.code).toBe('RESET_LINK_INVALID');
  });

  it('rejects expired links', async () => {
    const user = await signedInUser(app);
    const client = await browserClient(app);
    await client.post('/api/v1/auth/forgot-password', { email: user.email });
    const token = decodeURIComponent(/token=([^\s&]+)/.exec(testOutbox[0]!.text)![1]!);
    await prisma.passwordResetToken.updateMany({
      where: { userId: user.userId },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });
    const res = await client.post('/api/v1/auth/reset-password', {
      token,
      password: 'Brand-New-Pass1',
    });
    expect(res.status).toBe(400);
  });
});

describe('dashboard and reports', () => {
  it('computes totals from saved records', async () => {
    const { o, invoiceId, customerId } = await issuedInvoice(1_000_000);
    await o.post(`${base(o.tenantId)}/payments`, pay(250_000, invoiceId));
    const job = await o.post(`${base(o.tenantId)}/jobs`, {
      customerId,
      bookingDate: today,
      originCity: 'Mumbai',
      destinationCity: 'Pune',
      goodsDescription: 'Steel',
      freightAmountMinor: 500_000,
    });
    const delivered = await o.post(`${base(o.tenantId)}/jobs`, {
      customerId,
      bookingDate: today,
      originCity: 'Pune',
      destinationCity: 'Nashik',
      goodsDescription: 'Steel',
      freightAmountMinor: 300_000,
    });
    await o.post(`${base(o.tenantId)}/jobs/${delivered.body.id}/status`, { status: 'DELIVERED' });

    const d = await o.get(`${base(o.tenantId)}/dashboard`);
    expect(d.status).toBe(200);
    expect(d.body).toMatchObject({
      jobs: { active: 1, inTransit: 0, deliveredAwaitingInvoice: 1 },
      invoicesThisMonth: { count: 1, totalMinor: 1_000_000 },
      outstanding: { count: 1, amountMinor: 750_000 },
      receivedThisMonthMinor: 250_000,
      counts: { activeCustomers: 1 },
    });
    expect(d.body.recentJobs.map((j: { id: string }) => j.id)).toContain(job.body.id);
    expect(d.body.recentInvoices[0]).toMatchObject({ id: invoiceId, balanceMinor: 750_000 });

    const rec = await o.get(`${base(o.tenantId)}/reports/receivables`);
    expect(rec.body.items[0]).toMatchObject({
      customerName: 'ABC Ltd.',
      totalMinor: 750_000,
      invoiceCount: 1,
    });

    const range = `from=${today.slice(0, 8)}01&to=${today}`;
    const jobs = await o.get(`${base(o.tenantId)}/reports/jobs?${range}`);
    expect(jobs.body.topRoutes).toHaveLength(2);
    const invs = await o.get(`${base(o.tenantId)}/reports/invoices?${range}`);
    expect(invs.body.totals).toMatchObject({
      invoices: 1,
      totalMinor: 1_000_000,
      paidMinor: 250_000,
    });
    expect(
      (await o.get(`${base(o.tenantId)}/reports/jobs?from=2026-12-01&to=2026-01-01`)).status,
    ).toBe(400);

    // Another company sees none of it.
    const other = await ownerWithTenant(app);
    const od = await other.get(`${base(other.tenantId)}/dashboard`);
    expect(od.body.outstanding.amountMinor).toBe(0);
    expect(od.body.recentInvoices).toHaveLength(0);
  });
});
