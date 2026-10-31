import { prisma } from '../../services/prisma.js';
import { todayIn, toDateOnly } from '../../utils/fields.js';
import { Prisma } from '../../generated/prisma/client.js';

/** Raw SQL aggregates come back as bigint/Decimal/string; money and counts fit in a JS number. */
function num(v: unknown): number {
  if (v === null || v === undefined) return 0;
  return Number(typeof v === 'object' ? String(v) : v);
}

function monthBounds(timeZone: string) {
  const today = todayIn(timeZone);
  const [y, m] = today.split('-').map(Number) as [number, number];
  const start = new Date(Date.UTC(y, m - 1, 1));
  const end = new Date(Date.UTC(y, m, 1));
  return { today: new Date(`${today}T00:00:00.000Z`), start, end };
}

const OPEN = ['ISSUED', 'PARTIALLY_PAID'] as const;
const ISSUED_LIKE = ['ISSUED', 'PARTIALLY_PAID', 'PAID'] as const;

/**
 * Dashboard totals (project plan section 17). Every figure is aggregated in MySQL from
 * persisted records; nothing is hardcoded.
 */
export async function dashboard(tenantId: string) {
  const tenant = await prisma.tenant.findUniqueOrThrow({
    where: { id: tenantId },
    select: { timezone: true },
  });
  const { today, start, end } = monthBounds(tenant.timezone);

  const [
    activeJobs,
    inTransit,
    awaitingInvoice,
    issuedThisMonth,
    outstanding,
    overdue,
    received,
    customers,
    vehicles,
    recentJobs,
    recentInvoices,
  ] = await Promise.all([
    prisma.transportJob.count({ where: { tenantId, status: { in: ['BOOKED', 'IN_TRANSIT'] } } }),
    prisma.transportJob.count({ where: { tenantId, status: 'IN_TRANSIT' } }),
    // Delivered and not on an issued invoice (a draft does not count as billed).
    prisma.transportJob.count({
      where: {
        tenantId,
        status: 'DELIVERED',
        OR: [{ invoiceLink: { is: null } }, { invoiceLink: { invoice: { status: 'DRAFT' } } }],
      },
    }),
    prisma.invoice.aggregate({
      where: { tenantId, status: { in: [...ISSUED_LIKE] }, invoiceDate: { gte: start, lt: end } },
      _count: { _all: true },
      _sum: { grandTotalMinor: true },
    }),
    prisma.invoice.aggregate({
      where: { tenantId, status: { in: [...OPEN] } },
      _count: { _all: true },
      _sum: { grandTotalMinor: true, amountPaidMinor: true },
    }),
    prisma.invoice.aggregate({
      where: { tenantId, status: { in: [...OPEN] }, dueDate: { lt: today } },
      _count: { _all: true },
      _sum: { grandTotalMinor: true, amountPaidMinor: true },
    }),
    // Received this month = allocations of valid payments dated this month (no double counting).
    prisma.paymentAllocation.aggregate({
      where: { tenantId, payment: { status: 'RECORDED', paymentDate: { gte: start, lt: end } } },
      _sum: { allocatedAmountMinor: true },
    }),
    prisma.customer.count({ where: { tenantId, status: 'ACTIVE' } }),
    prisma.vehicle.count({ where: { tenantId, status: 'ACTIVE' } }),
    prisma.transportJob.findMany({
      where: { tenantId },
      orderBy: { createdAt: 'desc' },
      take: 5,
      select: {
        id: true,
        jobNumber: true,
        status: true,
        originCity: true,
        destinationCity: true,
        bookingDate: true,
        customer: { select: { name: true } },
      },
    }),
    prisma.invoice.findMany({
      where: { tenantId, status: { not: 'DRAFT' } },
      orderBy: { issuedAt: 'desc' },
      take: 5,
      select: {
        id: true,
        invoiceNumber: true,
        status: true,
        invoiceDate: true,
        dueDate: true,
        grandTotalMinor: true,
        amountPaidMinor: true,
        customer: { select: { name: true } },
      },
    }),
  ]);

  const todayStr = toDateOnly(today)!;
  return {
    month: toDateOnly(start)!.slice(0, 7),
    jobs: { active: activeJobs, inTransit, deliveredAwaitingInvoice: awaitingInvoice },
    invoicesThisMonth: {
      count: issuedThisMonth._count._all,
      totalMinor: issuedThisMonth._sum.grandTotalMinor ?? 0,
    },
    outstanding: {
      count: outstanding._count._all,
      amountMinor:
        (outstanding._sum.grandTotalMinor ?? 0) - (outstanding._sum.amountPaidMinor ?? 0),
    },
    overdue: {
      count: overdue._count._all,
      amountMinor: (overdue._sum.grandTotalMinor ?? 0) - (overdue._sum.amountPaidMinor ?? 0),
    },
    receivedThisMonthMinor: received._sum.allocatedAmountMinor ?? 0,
    counts: { activeCustomers: customers, activeVehicles: vehicles },
    recentJobs: recentJobs.map((j) => ({ ...j, bookingDate: toDateOnly(j.bookingDate) })),
    recentInvoices: recentInvoices.map((i) => {
      const due = toDateOnly(i.dueDate);
      const open = i.status === 'ISSUED' || i.status === 'PARTIALLY_PAID';
      return {
        ...i,
        invoiceDate: toDateOnly(i.invoiceDate),
        dueDate: due,
        balanceMinor: i.status === 'CANCELLED' ? 0 : i.grandTotalMinor - i.amountPaidMinor,
        displayStatus:
          open && due && due < todayStr && i.grandTotalMinor > i.amountPaidMinor
            ? 'OVERDUE'
            : i.status,
      };
    }),
  };
}

/** Outstanding per customer with ageing buckets by days past due. */
export async function receivablesReport(tenantId: string) {
  const tenant = await prisma.tenant.findUniqueOrThrow({
    where: { id: tenantId },
    select: { timezone: true },
  });
  const today = new Date(`${todayIn(tenant.timezone)}T00:00:00.000Z`);
  // Parameterised raw SQL (tagged template); no user input is interpolated.
  const rows = await prisma.$queryRaw<
    {
      customerId: string;
      customerName: string;
      invoices: bigint;
      notDue: unknown;
      d1_30: unknown;
      d31_60: unknown;
      d61_90: unknown;
      d90plus: unknown;
      total: unknown;
    }[]
  >(Prisma.sql`
    SELECT c.id AS customerId, c.name AS customerName, COUNT(*) AS invoices,
      SUM(CASE WHEN i.dueDate IS NULL OR i.dueDate >= ${today} THEN i.grandTotalMinor - i.amountPaidMinor ELSE 0 END) AS notDue,
      SUM(CASE WHEN DATEDIFF(${today}, i.dueDate) BETWEEN 1 AND 30 THEN i.grandTotalMinor - i.amountPaidMinor ELSE 0 END) AS d1_30,
      SUM(CASE WHEN DATEDIFF(${today}, i.dueDate) BETWEEN 31 AND 60 THEN i.grandTotalMinor - i.amountPaidMinor ELSE 0 END) AS d31_60,
      SUM(CASE WHEN DATEDIFF(${today}, i.dueDate) BETWEEN 61 AND 90 THEN i.grandTotalMinor - i.amountPaidMinor ELSE 0 END) AS d61_90,
      SUM(CASE WHEN DATEDIFF(${today}, i.dueDate) > 90 THEN i.grandTotalMinor - i.amountPaidMinor ELSE 0 END) AS d90plus,
      SUM(i.grandTotalMinor - i.amountPaidMinor) AS total
    FROM invoices i JOIN customers c ON c.id = i.customerId AND c.tenantId = i.tenantId
    WHERE i.tenantId = ${tenantId} AND i.status IN ('ISSUED', 'PARTIALLY_PAID')
    GROUP BY c.id, c.name
    ORDER BY total DESC
    LIMIT 500`);
  const items = rows.map((r) => ({
    customerId: r.customerId,
    customerName: r.customerName,
    invoiceCount: num(r.invoices),
    notDueMinor: num(r.notDue),
    days1to30Minor: num(r.d1_30),
    days31to60Minor: num(r.d31_60),
    days61to90Minor: num(r.d61_90),
    days90PlusMinor: num(r.d90plus),
    totalMinor: num(r.total),
  }));
  const sum = (k: keyof (typeof items)[number]) => items.reduce((s, i) => s + (i[k] as number), 0);
  return {
    asOf: toDateOnly(today),
    items,
    totals: {
      notDueMinor: sum('notDueMinor'),
      days1to30Minor: sum('days1to30Minor'),
      days31to60Minor: sum('days31to60Minor'),
      days61to90Minor: sum('days61to90Minor'),
      days90PlusMinor: sum('days90PlusMinor'),
      totalMinor: sum('totalMinor'),
    },
  };
}

export interface Range {
  from: Date;
  to: Date;
}

/** Jobs by status, by month (booking date), top routes and vehicle usage in a date range. */
export async function jobsReport(tenantId: string, { from, to }: Range) {
  const where = { tenantId, bookingDate: { gte: from, lte: to } };
  const [byStatus, byMonth, routes, vehicles] = await Promise.all([
    prisma.transportJob.groupBy({
      by: ['status'],
      where,
      _count: { _all: true },
      orderBy: { status: 'asc' },
    }),
    prisma.$queryRaw<{ month: string; jobs: bigint; freight: unknown }[]>(Prisma.sql`
      SELECT DATE_FORMAT(bookingDate, '%Y-%m') AS month, COUNT(*) AS jobs, SUM(freightAmountMinor) AS freight
      FROM transport_jobs
      WHERE tenantId = ${tenantId} AND bookingDate BETWEEN ${from} AND ${to} AND status <> 'CANCELLED'
      GROUP BY month ORDER BY month`),
    prisma.$queryRaw<
      { originCity: string; destinationCity: string; jobs: bigint; freight: unknown }[]
    >(Prisma.sql`
      SELECT originCity, destinationCity, COUNT(*) AS jobs, SUM(freightAmountMinor) AS freight
      FROM transport_jobs
      WHERE tenantId = ${tenantId} AND bookingDate BETWEEN ${from} AND ${to} AND status <> 'CANCELLED'
      GROUP BY originCity, destinationCity ORDER BY jobs DESC, freight DESC LIMIT 10`),
    prisma.$queryRaw<{ vehicleId: string; registration: string; jobs: bigint }[]>(Prisma.sql`
      SELECT v.id AS vehicleId, v.registrationNumberDisplay AS registration, COUNT(*) AS jobs
      FROM transport_jobs j JOIN vehicles v ON v.id = j.vehicleId
      WHERE j.tenantId = ${tenantId} AND j.bookingDate BETWEEN ${from} AND ${to} AND j.status <> 'CANCELLED'
      GROUP BY v.id, v.registrationNumberDisplay ORDER BY jobs DESC LIMIT 10`),
  ]);
  return {
    from: toDateOnly(from),
    to: toDateOnly(to),
    byStatus: byStatus.map((s) => ({ status: s.status, count: s._count._all })),
    byMonth: byMonth.map((m) => ({
      month: m.month,
      jobs: num(m.jobs),
      freightMinor: num(m.freight),
    })),
    topRoutes: routes.map((r) => ({
      originCity: r.originCity,
      destinationCity: r.destinationCity,
      jobs: num(r.jobs),
      freightMinor: num(r.freight),
    })),
    vehicleUsage: vehicles.map((v) => ({
      vehicleId: v.vehicleId,
      registration: v.registration,
      jobs: num(v.jobs),
    })),
  };
}

/** Issued invoices by month (invoice date) with tax split, and top customers. */
export async function invoicesReport(tenantId: string, { from, to }: Range) {
  const [byMonth, byCustomer] = await Promise.all([
    prisma.$queryRaw<
      {
        month: string;
        invoices: bigint;
        taxable: unknown;
        cgst: unknown;
        sgst: unknown;
        igst: unknown;
        total: unknown;
        paid: unknown;
      }[]
    >(Prisma.sql`
      SELECT DATE_FORMAT(invoiceDate, '%Y-%m') AS month, COUNT(*) AS invoices,
        SUM(taxableMinor) AS taxable, SUM(cgstMinor) AS cgst, SUM(sgstMinor) AS sgst, SUM(igstMinor) AS igst,
        SUM(grandTotalMinor) AS total, SUM(amountPaidMinor) AS paid
      FROM invoices
      WHERE tenantId = ${tenantId} AND invoiceDate BETWEEN ${from} AND ${to}
        AND status IN ('ISSUED', 'PARTIALLY_PAID', 'PAID')
      GROUP BY month ORDER BY month`),
    prisma.$queryRaw<
      {
        customerId: string;
        customerName: string;
        invoices: bigint;
        total: unknown;
        paid: unknown;
      }[]
    >(Prisma.sql`
      SELECT c.id AS customerId, c.name AS customerName, COUNT(*) AS invoices,
        SUM(i.grandTotalMinor) AS total, SUM(i.amountPaidMinor) AS paid
      FROM invoices i JOIN customers c ON c.id = i.customerId AND c.tenantId = i.tenantId
      WHERE i.tenantId = ${tenantId} AND i.invoiceDate BETWEEN ${from} AND ${to}
        AND i.status IN ('ISSUED', 'PARTIALLY_PAID', 'PAID')
      GROUP BY c.id, c.name ORDER BY total DESC LIMIT 10`),
  ]);
  const months = byMonth.map((m) => ({
    month: m.month,
    invoices: num(m.invoices),
    taxableMinor: num(m.taxable),
    cgstMinor: num(m.cgst),
    sgstMinor: num(m.sgst),
    igstMinor: num(m.igst),
    totalMinor: num(m.total),
    paidMinor: num(m.paid),
  }));
  const total = (k: keyof (typeof months)[number]) =>
    months.reduce((s, m) => s + (m[k] as number), 0);
  return {
    from: toDateOnly(from),
    to: toDateOnly(to),
    byMonth: months,
    totals: {
      invoices: total('invoices'),
      taxableMinor: total('taxableMinor'),
      cgstMinor: total('cgstMinor'),
      sgstMinor: total('sgstMinor'),
      igstMinor: total('igstMinor'),
      totalMinor: total('totalMinor'),
      paidMinor: total('paidMinor'),
    },
    topCustomers: byCustomer.map((c) => ({
      customerId: c.customerId,
      customerName: c.customerName,
      invoices: num(c.invoices),
      totalMinor: num(c.total),
      paidMinor: num(c.paid),
    })),
  };
}
