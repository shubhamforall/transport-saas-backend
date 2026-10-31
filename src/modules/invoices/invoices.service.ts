import type { Request } from 'express';
import type { Prisma, TaxType } from '../../generated/prisma/client.js';
import { prisma } from '../../services/prisma.js';
import { audit } from '../../services/audit.js';
import { AppError } from '../../utils/app-error.js';
import { addDays, todayDateIn, todayIn, toDateOnly } from '../../utils/fields.js';
import { paged, skipTake } from '../../utils/list.js';
import { isUniqueViolation } from '../../utils/prisma-errors.js';
import { CalcError, calcInvoice, financialYear, formatInvoiceNumber } from './calc.js';
import type {
  CreateInvoiceInput,
  InvoiceListQuery,
  ItemInput,
  UpdateInvoiceInput,
} from './invoices.schemas.js';

// ---- Read model -----------------------------------------------------------------------------

const invoiceInclude = {
  customer: true,
  items: { orderBy: { sortOrder: 'asc' } },
  jobLinks: {
    include: {
      job: {
        select: {
          id: true,
          jobNumber: true,
          originCity: true,
          destinationCity: true,
          goodsDescription: true,
          lrNumber: true,
          actualDeliveryDate: true,
          vehicle: { select: { registrationNumberDisplay: true } },
        },
      },
    },
  },
  allocations: {
    where: { payment: { status: 'RECORDED' } },
    include: {
      payment: {
        select: { id: true, paymentDate: true, method: true, reference: true, amountMinor: true },
      },
    },
    orderBy: { createdAt: 'asc' },
  },
} satisfies Prisma.InvoiceInclude;

export type InvoiceRow = Prisma.InvoiceGetPayload<{ include: typeof invoiceInclude }>;

const listInclude = {
  customer: { select: { id: true, name: true } },
} satisfies Prisma.InvoiceInclude;

type PartySnapshot = {
  name: string;
  legalName?: string | null;
  contactPerson?: string | null;
  email?: string | null;
  phone?: string | null;
  addressLine1?: string | null;
  addressLine2?: string | null;
  city?: string | null;
  state?: string | null;
  stateCode?: string | null;
  postalCode?: string | null;
  gstin?: string | null;
  paymentInstructions?: string | null;
};

function customerSnapshot(c: InvoiceRow['customer']): PartySnapshot {
  return {
    name: c.name,
    contactPerson: c.contactPerson,
    email: c.email,
    phone: c.phone,
    addressLine1: c.addressLine1,
    addressLine2: c.addressLine2,
    city: c.city,
    state: c.state,
    stateCode: c.stateCode,
    postalCode: c.postalCode,
    gstin: c.gstin,
  };
}

type TenantRow = Prisma.TenantGetPayload<object>;

function companySnapshot(t: TenantRow): PartySnapshot {
  return {
    name: t.name,
    legalName: t.legalName,
    email: t.email,
    phone: t.phone,
    addressLine1: t.addressLine1,
    addressLine2: t.addressLine2,
    city: t.city,
    state: t.state,
    stateCode: t.stateCode,
    postalCode: t.postalCode,
    gstin: t.gstin,
    paymentInstructions: t.paymentInstructions,
  };
}

type DisplayStatus = 'DRAFT' | 'ISSUED' | 'PARTIALLY_PAID' | 'PAID' | 'CANCELLED' | 'OVERDUE';

/** Overdue is derived: issued/partly paid, past due date, money still owed. */
export function displayStatus(
  inv: { status: string; dueDate: Date | null; grandTotalMinor: number; amountPaidMinor: number },
  today: string,
): DisplayStatus {
  const open = inv.status === 'ISSUED' || inv.status === 'PARTIALLY_PAID';
  const due = toDateOnly(inv.dueDate);
  if (open && due && due < today && inv.grandTotalMinor > inv.amountPaidMinor) return 'OVERDUE';
  return inv.status as DisplayStatus;
}

function balance(inv: { status: string; grandTotalMinor: number; amountPaidMinor: number }) {
  return inv.status === 'CANCELLED' ? 0 : inv.grandTotalMinor - inv.amountPaidMinor;
}

export function toInvoiceDto(inv: InvoiceRow, tenant: TenantRow) {
  const today = todayIn(tenant.timezone);
  const issued = inv.status !== 'DRAFT';
  return {
    id: inv.id,
    invoiceNumber: inv.invoiceNumber,
    status: inv.status,
    displayStatus: displayStatus(inv, today),
    customerId: inv.customerId,
    customer: { id: inv.customer.id, name: inv.customer.name, email: inv.customer.email },
    invoiceDate: toDateOnly(inv.invoiceDate),
    dueDate: toDateOnly(inv.dueDate),
    taxType: inv.taxType,
    placeOfSupplyStateCode: inv.placeOfSupplyStateCode,
    // Issued invoices show the details frozen at issue; drafts show current details.
    billTo:
      (issued && (inv.customerSnapshot as PartySnapshot | null)) || customerSnapshot(inv.customer),
    from: (issued && (inv.companySnapshot as PartySnapshot | null)) || companySnapshot(tenant),
    currency: inv.currency,
    subtotalMinor: inv.subtotalMinor,
    discountMinor: inv.discountMinor,
    taxableMinor: inv.taxableMinor,
    cgstMinor: inv.cgstMinor,
    sgstMinor: inv.sgstMinor,
    igstMinor: inv.igstMinor,
    taxTotalMinor: inv.taxTotalMinor,
    grandTotalMinor: inv.grandTotalMinor,
    amountPaidMinor: inv.amountPaidMinor,
    balanceMinor: balance(inv),
    notes: inv.notes,
    terms: inv.terms,
    items: inv.items.map((i) => ({
      id: i.id,
      description: i.description,
      sacCode: i.sacCode,
      quantityMilli: i.quantityMilli,
      unitPriceMinor: i.unitPriceMinor,
      discountMinor: i.discountMinor,
      taxableAmountMinor: i.taxableAmountMinor,
      taxRateBps: i.taxRateBps,
      taxAmountMinor: i.taxAmountMinor,
      lineTotalMinor: i.lineTotalMinor,
    })),
    jobs: inv.jobLinks.map((l) => ({
      ...l.job,
      vehicle: undefined,
      vehicleRegistration: l.job.vehicle?.registrationNumberDisplay ?? null,
      actualDeliveryDate: toDateOnly(l.job.actualDeliveryDate),
    })),
    payments: inv.allocations.map((a) => ({
      paymentId: a.payment.id,
      paymentDate: toDateOnly(a.payment.paymentDate),
      method: a.payment.method,
      reference: a.payment.reference,
      allocatedAmountMinor: a.allocatedAmountMinor,
    })),
    issuedAt: inv.issuedAt,
    cancelledAt: inv.cancelledAt,
    cancellationReason: inv.cancellationReason,
    lastEmailedAt: inv.lastEmailedAt,
    createdAt: inv.createdAt,
    updatedAt: inv.updatedAt,
  };
}

export async function loadInvoice(tenantId: string, id: string) {
  const [inv, tenant] = await Promise.all([
    prisma.invoice.findFirst({ where: { id, tenantId }, include: invoiceInclude }),
    prisma.tenant.findUniqueOrThrow({ where: { id: tenantId } }),
  ]);
  if (!inv) throw AppError.notFound('Invoice not found');
  return { inv, tenant };
}

export async function getInvoice(tenantId: string, id: string) {
  const { inv, tenant } = await loadInvoice(tenantId, id);
  return toInvoiceDto(inv, tenant);
}

export async function listInvoices(tenantId: string, q: InvoiceListQuery) {
  const tenant = await prisma.tenant.findUniqueOrThrow({ where: { id: tenantId } });
  const today = todayDateIn(tenant.timezone);
  const and: Prisma.InvoiceWhereInput[] = [{ tenantId }];
  if (q.status?.length) {
    const real = q.status.filter((s) => s !== 'OVERDUE') as Prisma.InvoiceWhereInput['status'][];
    const or: Prisma.InvoiceWhereInput[] = [];
    if (real.length) or.push({ status: { in: real as never } });
    if (q.status.includes('OVERDUE')) {
      or.push({ status: { in: ['ISSUED', 'PARTIALLY_PAID'] }, dueDate: { lt: today } });
    }
    and.push({ OR: or });
  }
  if (q.customerId) and.push({ customerId: q.customerId });
  if (q.from || q.to) and.push({ invoiceDate: { gte: q.from, lte: q.to } });
  if (q.q) {
    and.push({
      OR: [{ invoiceNumber: { contains: q.q } }, { customer: { name: { contains: q.q } } }],
    });
  }
  const where = { AND: and };
  const orderBy: Prisma.InvoiceOrderByWithRelationInput[] =
    q.sort === 'invoiceDate'
      ? [{ invoiceDate: q.order }, { createdAt: q.order }]
      : q.sort === 'grandTotal'
        ? [{ grandTotalMinor: q.order }]
        : q.sort === 'dueDate'
          ? [{ dueDate: q.order }]
          : [{ createdAt: q.order }];
  const [rows, total] = await prisma.$transaction([
    prisma.invoice.findMany({
      where,
      orderBy,
      include: listInclude,
      ...skipTake(q.page, q.pageSize),
    }),
    prisma.invoice.count({ where }),
  ]);
  const todayStr = todayIn(tenant.timezone);
  const items = rows.map((inv) => ({
    id: inv.id,
    invoiceNumber: inv.invoiceNumber,
    status: inv.status,
    displayStatus: displayStatus(inv, todayStr),
    customer: inv.customer,
    invoiceDate: toDateOnly(inv.invoiceDate),
    dueDate: toDateOnly(inv.dueDate),
    grandTotalMinor: inv.grandTotalMinor,
    amountPaidMinor: inv.amountPaidMinor,
    balanceMinor: balance(inv),
    lastEmailedAt: inv.lastEmailedAt,
    createdAt: inv.createdAt,
  }));
  return paged(items, total, q.page, q.pageSize);
}

// ---- Writes ---------------------------------------------------------------------------------

function computeItems(items: ItemInput[], taxType: TaxType) {
  try {
    const { lines, totals } = calcInvoice(items, taxType);
    return {
      totals,
      rows: items.map((item, i) => ({
        description: item.description,
        sacCode: item.sacCode ?? null,
        quantityMilli: item.quantityMilli,
        unitPriceMinor: item.unitPriceMinor,
        discountMinor: lines[i]!.discountMinor,
        taxableAmountMinor: lines[i]!.taxableAmountMinor,
        taxRateBps: taxType === 'NONE' ? 0 : item.taxRateBps,
        taxAmountMinor: lines[i]!.taxAmountMinor,
        lineTotalMinor: lines[i]!.lineTotalMinor,
        sortOrder: i,
      })),
    };
  } catch (err) {
    if (err instanceof CalcError) {
      throw AppError.badRequest('Validation failed', { [err.field]: [err.message] });
    }
    throw err;
  }
}

/** Suggests CGST+SGST for same-state supply, IGST otherwise. */
function defaultTaxType(tenant: TenantRow, placeOfSupply: string | null | undefined): TaxType {
  if (tenant.defaultTaxRateBps === 0) return 'NONE';
  if (tenant.stateCode && placeOfSupply && tenant.stateCode !== placeOfSupply) return 'INTER_STATE';
  return 'INTRA_STATE';
}

type JobForInvoice = Prisma.TransportJobGetPayload<{
  include: { charges: true; vehicle: { select: { registrationNumberDisplay: true } } };
}>;

/** Invoice lines prefilled from a job: freight (with the job discount) plus each extra charge. */
function linesFromJob(job: JobForInvoice, tenant: TenantRow): ItemInput[] {
  const rate = job.taxRateBps ?? tenant.defaultTaxRateBps;
  const details = [
    job.jobNumber,
    job.vehicle ? `Vehicle ${job.vehicle.registrationNumberDisplay}` : null,
    job.lrNumber ? `LR ${job.lrNumber}` : null,
  ].filter(Boolean);
  const freightDescription =
    `Freight: ${job.originCity} to ${job.destinationCity} (${details.join(', ')}) - ${job.goodsDescription}`.slice(
      0,
      500,
    );
  // Spread the job discount over freight first, then charges, so no line goes negative.
  let discountLeft = job.discountAmountMinor;
  const take = (amount: number) => {
    const d = Math.min(discountLeft, amount);
    discountLeft -= d;
    return d;
  };
  const base = { quantityMilli: 1000, taxRateBps: rate, sacCode: tenant.defaultSacCode };
  return [
    {
      ...base,
      description: freightDescription,
      unitPriceMinor: job.freightAmountMinor,
      discountMinor: take(job.freightAmountMinor),
    },
    ...job.charges.map((c) => ({
      ...base,
      description: `${c.description} (${job.jobNumber})`.slice(0, 500),
      unitPriceMinor: c.amountMinor,
      discountMinor: take(c.amountMinor),
    })),
  ];
}

async function assertActiveCustomer(tx: Prisma.TransactionClient, tenantId: string, id: string) {
  const c = await tx.customer.findFirst({ where: { id, tenantId } });
  if (!c) throw AppError.badRequest('Validation failed', { customerId: ['Customer not found'] });
  if (c.status !== 'ACTIVE') {
    throw AppError.badRequest('Validation failed', { customerId: ['This customer is archived'] });
  }
  return c;
}

export async function createInvoice(
  tenantId: string,
  userId: string,
  input: CreateInvoiceInput,
  req: Request,
) {
  try {
    const id = await prisma.$transaction(async (tx) => {
      const tenant = await tx.tenant.findUniqueOrThrow({ where: { id: tenantId } });
      let customerId = input.customerId;
      let items = input.items ?? [];

      let jobs: JobForInvoice[] = [];
      if (input.jobIds) {
        const ids = [...new Set(input.jobIds)];
        jobs = await tx.transportJob.findMany({
          where: { id: { in: ids }, tenantId },
          include: { charges: { orderBy: { sortOrder: 'asc' } }, vehicle: true },
        });
        if (jobs.length !== ids.length) {
          throw AppError.badRequest('Validation failed', { jobIds: ['Job not found'] });
        }
        const notDelivered = jobs.find((j) => j.status !== 'DELIVERED');
        if (notDelivered) {
          throw AppError.badRequest('Validation failed', {
            jobIds: [`${notDelivered.jobNumber} is not delivered yet`],
          });
        }
        const customers = new Set(jobs.map((j) => j.customerId));
        if (customers.size > 1) {
          throw AppError.badRequest('Validation failed', {
            jobIds: ['All jobs on one invoice must be for the same customer'],
          });
        }
        const jobCustomer = jobs[0]!.customerId;
        if (customerId && customerId !== jobCustomer) {
          throw AppError.badRequest('Validation failed', {
            customerId: ['Customer does not match the selected jobs'],
          });
        }
        customerId = jobCustomer;
        if (!input.items) items = jobs.flatMap((j) => linesFromJob(j, tenant));
      }

      const customer = await assertActiveCustomer(tx, tenantId, customerId!);
      const invoiceDate = input.invoiceDate ?? todayDateIn(tenant.timezone);
      const terms = customer.paymentTermsDays ?? tenant.defaultPaymentTermsDays;
      const placeOfSupply =
        input.placeOfSupplyStateCode !== undefined
          ? input.placeOfSupplyStateCode
          : customer.stateCode;
      const taxType = input.taxType ?? defaultTaxType(tenant, placeOfSupply);
      const { rows, totals } = computeItems(items, taxType);

      const invoice = await tx.invoice.create({
        data: {
          tenantId,
          customerId: customer.id,
          invoiceDate,
          dueDate: input.dueDate !== undefined ? input.dueDate : addDays(invoiceDate, terms),
          taxType,
          placeOfSupplyStateCode: placeOfSupply ?? null,
          notes: input.notes ?? null,
          terms: input.terms !== undefined ? input.terms : tenant.invoiceTerms,
          createdByUserId: userId,
          ...totals,
          items: { create: rows },
        },
        select: { id: true },
      });
      // Unique per job: a job already on another invoice fails here, even under concurrency.
      for (const job of jobs) {
        await tx.invoiceJob.create({
          data: { tenantId, invoiceId: invoice.id, transportJobId: job.id },
        });
      }
      await audit(
        tx,
        {
          tenantId,
          actorUserId: userId,
          action: 'invoice.draft_created',
          entityType: 'Invoice',
          entityId: invoice.id,
          metadata: { jobIds: jobs.map((j) => j.id) },
        },
        req,
      );
      return invoice.id;
    });
    return getInvoice(tenantId, id);
  } catch (err) {
    if (isUniqueViolation(err)) {
      throw new AppError(
        409,
        'JOB_ALREADY_INVOICED',
        'One of these jobs is already on another invoice.',
        {
          jobIds: ['Already on another invoice'],
        },
      );
    }
    throw err;
  }
}

async function lockDraft(tx: Prisma.TransactionClient, tenantId: string, id: string) {
  const inv = await tx.invoice.findFirst({
    where: { id, tenantId },
    include: { jobLinks: { select: { id: true } } },
  });
  if (!inv) throw AppError.notFound('Invoice not found');
  if (inv.status !== 'DRAFT') {
    throw new AppError(
      409,
      'INVOICE_NOT_DRAFT',
      'Issued invoices cannot be edited. Cancel it instead.',
    );
  }
  // Touch the row so concurrent edits/issue wait for this transaction.
  const { count } = await tx.invoice.updateMany({
    where: { id, tenantId, status: 'DRAFT' },
    data: { updatedAt: new Date() },
  });
  if (count !== 1) throw new AppError(409, 'INVOICE_NOT_DRAFT', 'This invoice was just issued.');
  return inv;
}

export async function updateInvoice(
  tenantId: string,
  userId: string,
  id: string,
  input: UpdateInvoiceInput,
  req: Request,
) {
  await prisma.$transaction(async (tx) => {
    const inv = await lockDraft(tx, tenantId, id);
    if (input.customerId && input.customerId !== inv.customerId) {
      if (inv.jobLinks.length) {
        throw AppError.badRequest('Validation failed', {
          customerId: ['The customer comes from the linked jobs and cannot be changed'],
        });
      }
      await assertActiveCustomer(tx, tenantId, input.customerId);
    }
    const taxType = input.taxType ?? inv.taxType;
    let items = input.items;
    if (!items && input.taxType && input.taxType !== inv.taxType) {
      // Tax type changed: recalculate the saved lines.
      const saved = await tx.invoiceItem.findMany({
        where: { tenantId, invoiceId: id },
        orderBy: { sortOrder: 'asc' },
      });
      items = saved.map((s) => ({
        description: s.description,
        sacCode: s.sacCode,
        quantityMilli: s.quantityMilli,
        unitPriceMinor: s.unitPriceMinor,
        discountMinor: s.discountMinor,
        taxRateBps: s.taxRateBps,
      }));
    }
    const { items: _i, ...fields } = input;
    let totals = {};
    if (items) {
      const computed = computeItems(items, taxType);
      totals = computed.totals;
      await tx.invoiceItem.deleteMany({ where: { tenantId, invoiceId: id } });
      await tx.invoiceItem.createMany({
        data: computed.rows.map((r) => ({ ...r, tenantId, invoiceId: id })),
      });
    }
    const invoiceDate = fields.invoiceDate ?? inv.invoiceDate;
    const dueDate = fields.dueDate !== undefined ? fields.dueDate : inv.dueDate;
    if (dueDate && dueDate < invoiceDate) {
      throw AppError.badRequest('Validation failed', {
        dueDate: ['Due date cannot be before the invoice date'],
      });
    }
    await tx.invoice.update({ where: { id }, data: { ...fields, ...totals } });
    await audit(
      tx,
      {
        tenantId,
        actorUserId: userId,
        action: 'invoice.draft_updated',
        entityType: 'Invoice',
        entityId: id,
        metadata: { fields: Object.keys(input) },
      },
      req,
    );
  });
  return getInvoice(tenantId, id);
}

export async function deleteDraft(tenantId: string, userId: string, id: string, req: Request) {
  await prisma.$transaction(async (tx) => {
    await lockDraft(tx, tenantId, id);
    // Cascades remove lines and job links, so the jobs become billable again.
    await tx.invoice.delete({ where: { id } });
    await audit(
      tx,
      {
        tenantId,
        actorUserId: userId,
        action: 'invoice.draft_deleted',
        entityType: 'Invoice',
        entityId: id,
      },
      req,
    );
  });
}

/** What is missing before an invoice can be issued (empty = ready). */
function issueProblems(
  inv: { taxType: TaxType; placeOfSupplyStateCode: string | null; grandTotalMinor: number },
  itemCount: number,
  tenant: TenantRow,
  customer: InvoiceRow['customer'],
) {
  const p: Record<string, string[]> = {};
  if (itemCount === 0) p.items = ['Add at least one line'];
  else if (inv.grandTotalMinor <= 0) p.items = ['Invoice total must be more than zero'];
  if (!tenant.addressLine1 || !tenant.city || !tenant.stateCode) {
    p.company = ['Add your company address, city and state in Company settings'];
  }
  if (customer.status !== 'ACTIVE') p.customerId = ['This customer is archived'];
  if (inv.taxType !== 'NONE') {
    if (!tenant.gstin) p.company = [...(p.company ?? []), 'Add your GSTIN to charge GST'];
    if (!inv.placeOfSupplyStateCode) p.placeOfSupplyStateCode = ['Choose the place of supply'];
  }
  return p;
}

class AlreadyIssued extends Error {}

/**
 * Issues a draft: validates, freezes customer/company details, assigns the next invoice
 * number. Safe to call twice: the second call returns the already-issued invoice.
 */
export async function issueInvoice(tenantId: string, userId: string, id: string, req: Request) {
  const existing = await prisma.invoice.findFirst({
    where: { id, tenantId },
    select: { status: true, invoiceDate: true },
  });
  if (!existing) throw AppError.notFound('Invoice not found');
  if (existing.status === 'CANCELLED') {
    throw new AppError(409, 'INVOICE_CANCELLED', 'This invoice is cancelled.');
  }
  if (existing.status !== 'DRAFT') return getInvoice(tenantId, id);

  const fy = financialYear(existing.invoiceDate);
  await prisma.invoiceSequence.createMany({
    data: [{ tenantId, financialYear: fy, nextNumber: 1 }],
    skipDuplicates: true,
  });

  try {
    await prisma.$transaction(async (tx) => {
      // Claim the draft first. A concurrent issue waits here, then finds 0 rows.
      const claimed = await tx.invoice.updateMany({
        where: { id, tenantId, status: 'DRAFT' },
        data: { status: 'ISSUED' },
      });
      if (claimed.count !== 1) throw new AlreadyIssued();

      const inv = await tx.invoice.findUniqueOrThrow({
        where: { id },
        include: { customer: true, items: { orderBy: { sortOrder: 'asc' } } },
      });
      const tenant = await tx.tenant.findUniqueOrThrow({ where: { id: tenantId } });

      // Recalculate from the saved lines; never trust stored or client totals.
      const { rows, totals } = computeItems(inv.items, inv.taxType);
      const problems = issueProblems({ ...inv, ...totals }, rows.length, tenant, inv.customer);
      if (Object.keys(problems).length) {
        throw new AppError(
          400,
          'INVOICE_INCOMPLETE',
          'Some details are missing before this invoice can be issued.',
          problems,
        );
      }

      const seq = await tx.invoiceSequence.update({
        where: { tenantId_financialYear: { tenantId, financialYear: fy } },
        data: { nextNumber: { increment: 1 } },
        select: { nextNumber: true },
      });
      let invoiceNumber: string;
      try {
        invoiceNumber = formatInvoiceNumber(tenant.invoicePrefix, fy, seq.nextNumber - 1);
      } catch {
        throw new AppError(
          409,
          'NUMBERING_LIMIT',
          'Invoice numbers are too long. Use a shorter invoice prefix.',
        );
      }

      await tx.invoice.update({
        where: { id },
        data: {
          ...totals,
          invoiceNumber,
          customerSnapshot: customerSnapshot(inv.customer),
          companySnapshot: companySnapshot(tenant),
          issuedAt: new Date(),
          issuedByUserId: userId,
        },
      });
      await audit(
        tx,
        {
          tenantId,
          actorUserId: userId,
          action: 'invoice.issued',
          entityType: 'Invoice',
          entityId: id,
          metadata: { invoiceNumber, grandTotalMinor: totals.grandTotalMinor },
        },
        req,
      );
    });
  } catch (err) {
    if (!(err instanceof AlreadyIssued)) throw err;
  }
  return getInvoice(tenantId, id);
}

export async function cancelInvoice(
  tenantId: string,
  userId: string,
  id: string,
  reason: string,
  req: Request,
) {
  await prisma.$transaction(async (tx) => {
    const inv = await tx.invoice.findFirst({ where: { id, tenantId } });
    if (!inv) throw AppError.notFound('Invoice not found');
    if (inv.status === 'CANCELLED') return;
    if (inv.status === 'DRAFT') {
      throw new AppError(409, 'INVOICE_IS_DRAFT', 'Drafts are deleted, not cancelled.');
    }
    // Conditional on "no payments" so a payment recorded at the same moment cannot slip by.
    const { count } = await tx.invoice.updateMany({
      where: { id, tenantId, status: 'ISSUED', amountPaidMinor: 0 },
      data: {
        status: 'CANCELLED',
        cancelledAt: new Date(),
        cancelledByUserId: userId,
        cancellationReason: reason,
      },
    });
    if (count !== 1) {
      throw new AppError(
        409,
        'HAS_PAYMENTS',
        'This invoice has payments. Void them before cancelling.',
      );
    }
    // Free the jobs so they can be billed on a corrected invoice.
    const links = await tx.invoiceJob.findMany({ where: { tenantId, invoiceId: id } });
    await tx.invoiceJob.deleteMany({ where: { tenantId, invoiceId: id } });
    await audit(
      tx,
      {
        tenantId,
        actorUserId: userId,
        action: 'invoice.cancelled',
        entityType: 'Invoice',
        entityId: id,
        metadata: {
          reason,
          invoiceNumber: inv.invoiceNumber,
          releasedJobIds: links.map((l) => l.transportJobId),
        },
      },
      req,
    );
  });
  return getInvoice(tenantId, id);
}
