import type { Request } from 'express';
import type { JobStatus, Prisma } from '../../generated/prisma/client.js';
import { prisma } from '../../services/prisma.js';
import { audit } from '../../services/audit.js';
import { ensureSequence, nextSequenceValue } from '../../services/sequences.js';
import { AppError } from '../../utils/app-error.js';
import { todayDateIn, toDateOnly } from '../../utils/fields.js';
import { paged, skipTake } from '../../utils/list.js';
import { normalizeRegistration } from '../vehicles/vehicles.schemas.js';
import {
  canTransition,
  TRANSITIONS,
  type CreateJobInput,
  type JobListQuery,
  type UpdateJobInput,
} from './jobs.schemas.js';

const jobInclude = {
  customer: { select: { id: true, name: true, status: true } },
  vehicle: { select: { id: true, registrationNumberDisplay: true, vehicleType: true } },
  charges: { orderBy: { sortOrder: 'asc' } },
  invoiceLink: {
    select: { invoice: { select: { id: true, invoiceNumber: true, status: true } } },
  },
} satisfies Prisma.TransportJobInclude;

type JobRow = Prisma.TransportJobGetPayload<{ include: typeof jobInclude }>;

/** Freight + extra charges - discount, in paise. */
export function jobTotalMinor(job: {
  freightAmountMinor: number;
  discountAmountMinor: number;
  charges: { amountMinor: number }[];
}) {
  const charges = job.charges.reduce((s, c) => s + c.amountMinor, 0);
  return job.freightAmountMinor + charges - job.discountAmountMinor;
}

export function toJobDto(job: JobRow) {
  const invoice = job.invoiceLink?.invoice ?? null;
  return {
    ...job,
    invoiceLink: undefined,
    bookingDate: toDateOnly(job.bookingDate),
    plannedPickupDate: toDateOnly(job.plannedPickupDate),
    actualPickupDate: toDateOnly(job.actualPickupDate),
    plannedDeliveryDate: toDateOnly(job.plannedDeliveryDate),
    actualDeliveryDate: toDateOnly(job.actualDeliveryDate),
    chargesTotalMinor: job.charges.reduce((s, c) => s + c.amountMinor, 0),
    totalMinor: jobTotalMinor(job),
    invoice,
    invoiceState: !invoice ? 'NOT_INVOICED' : invoice.status === 'DRAFT' ? 'IN_DRAFT' : 'INVOICED',
    allowedTransitions: invoice ? [] : TRANSITIONS[job.status],
  };
}

/** Customer and vehicle must belong to this company and be active. */
async function checkReferences(
  tx: Prisma.TransactionClient,
  tenantId: string,
  refs: { customerId?: string; vehicleId?: string | null },
) {
  if (refs.customerId) {
    const c = await tx.customer.findFirst({
      where: { id: refs.customerId, tenantId },
      select: { status: true },
    });
    if (!c) throw AppError.badRequest('Validation failed', { customerId: ['Customer not found'] });
    if (c.status !== 'ACTIVE') {
      throw AppError.badRequest('Validation failed', {
        customerId: ['This customer is archived. Restore it first.'],
      });
    }
  }
  if (refs.vehicleId) {
    const v = await tx.vehicle.findFirst({
      where: { id: refs.vehicleId, tenantId },
      select: { status: true },
    });
    if (!v) throw AppError.badRequest('Validation failed', { vehicleId: ['Vehicle not found'] });
    if (v.status !== 'ACTIVE') {
      throw AppError.badRequest('Validation failed', { vehicleId: ['This vehicle is inactive'] });
    }
  }
}

export async function listJobs(tenantId: string, q: JobListQuery) {
  const and: Prisma.TransportJobWhereInput[] = [{ tenantId }];
  if (q.status?.length) and.push({ status: { in: q.status } });
  if (q.customerId) and.push({ customerId: q.customerId });
  if (q.vehicleId) and.push({ vehicleId: q.vehicleId });
  if (q.bookingFrom || q.bookingTo) {
    and.push({ bookingDate: { gte: q.bookingFrom, lte: q.bookingTo } });
  }
  if (q.deliveryFrom || q.deliveryTo) {
    and.push({ actualDeliveryDate: { gte: q.deliveryFrom, lte: q.deliveryTo } });
  }
  if (q.invoiced === 'yes') and.push({ invoiceLink: { isNot: null } });
  if (q.invoiced === 'no') and.push({ invoiceLink: { is: null } });
  if (q.q) {
    const reg = normalizeRegistration(q.q).normalized;
    and.push({
      OR: [
        { jobNumber: { contains: q.q } },
        { lrNumber: { contains: q.q } },
        { originCity: { contains: q.q } },
        { destinationCity: { contains: q.q } },
        { customer: { name: { contains: q.q } } },
        ...(reg ? [{ vehicle: { registrationNumberNormalized: { contains: reg } } }] : []),
      ],
    });
  }
  const where = { AND: and };
  const orderBy: Prisma.TransportJobOrderByWithRelationInput[] =
    q.sort === 'bookingDate'
      ? [{ bookingDate: q.order }, { createdAt: q.order }]
      : q.sort === 'jobNumber'
        ? [{ jobNumber: q.order }]
        : [{ createdAt: q.order }];
  const [rows, total] = await prisma.$transaction([
    prisma.transportJob.findMany({
      where,
      orderBy,
      include: jobInclude,
      ...skipTake(q.page, q.pageSize),
    }),
    prisma.transportJob.count({ where }),
  ]);
  return paged(rows.map(toJobDto), total, q.page, q.pageSize);
}

/** Delivered jobs not linked to any invoice yet. */
export async function eligibleForInvoice(tenantId: string, customerId?: string) {
  const rows = await prisma.transportJob.findMany({
    where: {
      tenantId,
      status: 'DELIVERED',
      invoiceLink: { is: null },
      ...(customerId ? { customerId } : {}),
    },
    orderBy: [{ actualDeliveryDate: 'asc' }, { createdAt: 'asc' }],
    include: jobInclude,
    take: 200,
  });
  return { items: rows.map(toJobDto) };
}

export async function getJob(tenantId: string, id: string) {
  const job = await prisma.transportJob.findFirst({
    where: { id, tenantId },
    include: { ...jobInclude, statusEvents: { orderBy: { createdAt: 'asc' } } },
  });
  if (!job) throw AppError.notFound('Job not found');
  const { statusEvents, ...rest } = job;
  return { ...toJobDto(rest), statusHistory: statusEvents };
}

export async function createJob(
  tenantId: string,
  userId: string,
  input: CreateJobInput,
  req: Request,
) {
  await ensureSequence(tenantId, 'job');
  const { charges, ...data } = input;
  const id = await prisma.$transaction(async (tx) => {
    await checkReferences(tx, tenantId, data);
    const tenant = await tx.tenant.findUniqueOrThrow({
      where: { id: tenantId },
      select: { jobNumberPrefix: true },
    });
    const n = await nextSequenceValue(tx, tenantId, 'job');
    const job = await tx.transportJob.create({
      data: {
        ...data,
        tenantId,
        jobNumber: `${tenant.jobNumberPrefix}${String(n).padStart(4, '0')}`,
        createdByUserId: userId,
        // tenantId of nested rows comes from the parent through the composite relation.
        charges: {
          create: charges.map((c, i) => ({ ...c, sortOrder: i })),
        },
        statusEvents: {
          create: { toStatus: data.status, actorUserId: userId, note: 'Job created' },
        },
      },
      select: { id: true, jobNumber: true },
    });
    await audit(
      tx,
      {
        tenantId,
        actorUserId: userId,
        action: 'job.created',
        entityType: 'TransportJob',
        entityId: job.id,
        metadata: { jobNumber: job.jobNumber },
      },
      req,
    );
    return job.id;
  });
  return getJob(tenantId, id);
}

async function assertEditable(tx: Prisma.TransactionClient, tenantId: string, id: string) {
  const job = await tx.transportJob.findFirst({
    where: { id, tenantId },
    select: { status: true, invoiceLink: { select: { id: true } } },
  });
  if (!job) throw AppError.notFound('Job not found');
  if (job.invoiceLink) {
    throw new AppError(
      409,
      'JOB_INVOICED',
      'This job is on an invoice and can no longer be edited.',
    );
  }
  if (job.status === 'CANCELLED') {
    throw new AppError(409, 'JOB_CANCELLED', 'Cancelled jobs cannot be edited.');
  }
  return job;
}

export async function updateJob(
  tenantId: string,
  userId: string,
  id: string,
  input: UpdateJobInput,
  req: Request,
) {
  await prisma.$transaction(async (tx) => {
    await assertEditable(tx, tenantId, id);
    const { charges, ...data } = input;
    await checkReferences(tx, tenantId, {
      customerId: data.customerId,
      vehicleId: data.vehicleId,
    });
    if (charges) {
      await tx.transportJobCharge.deleteMany({ where: { tenantId, transportJobId: id } });
      await tx.transportJobCharge.createMany({
        data: charges.map((c, i) => ({ ...c, tenantId, transportJobId: id, sortOrder: i })),
      });
    }
    const job = await tx.transportJob.update({
      where: { id },
      data,
      include: { charges: true },
    });
    if (
      job.discountAmountMinor >
      job.freightAmountMinor + job.charges.reduce((s, c) => s + c.amountMinor, 0)
    ) {
      throw AppError.badRequest('Validation failed', {
        discountAmountMinor: ['Discount cannot be more than freight plus charges'],
      });
    }
    if (
      job.actualPickupDate &&
      job.actualDeliveryDate &&
      job.actualDeliveryDate < job.actualPickupDate
    ) {
      throw AppError.badRequest('Validation failed', {
        actualDeliveryDate: ['Delivery date cannot be before pickup date'],
      });
    }
    await audit(
      tx,
      {
        tenantId,
        actorUserId: userId,
        action: 'job.updated',
        entityType: 'TransportJob',
        entityId: id,
        metadata: { fields: Object.keys(input) },
      },
      req,
    );
  });
  return getJob(tenantId, id);
}

export async function changeJobStatus(
  tenantId: string,
  userId: string,
  id: string,
  to: JobStatus,
  note: string | null | undefined,
  date: Date | undefined,
  req: Request,
) {
  await prisma.$transaction(async (tx) => {
    const job = await tx.transportJob.findFirst({
      where: { id, tenantId },
      select: {
        status: true,
        actualPickupDate: true,
        actualDeliveryDate: true,
        invoiceLink: { select: { id: true } },
        tenant: { select: { timezone: true } },
      },
    });
    if (!job) throw AppError.notFound('Job not found');
    if (job.invoiceLink) {
      throw new AppError(409, 'JOB_INVOICED', 'This job is on an invoice; its status is locked.');
    }
    if (!canTransition(job.status, to)) {
      throw new AppError(
        409,
        'INVALID_TRANSITION',
        `A ${job.status.replace('_', ' ').toLowerCase()} job cannot be moved to ${to.replace('_', ' ').toLowerCase()}.`,
      );
    }
    const day = date ?? todayDateIn(job.tenant.timezone);
    const data: Prisma.TransportJobUncheckedUpdateManyInput = { status: to };
    if (to === 'IN_TRANSIT' && !job.actualPickupDate) data.actualPickupDate = day;
    if (to === 'DELIVERED') {
      if (!job.actualPickupDate) data.actualPickupDate = day;
      if (!job.actualDeliveryDate || date) data.actualDeliveryDate = day;
    }
    // Conditional update: a concurrent change in between makes this fail instead of overwriting.
    const { count } = await tx.transportJob.updateMany({
      where: { id, tenantId, status: job.status },
      data,
    });
    if (count !== 1)
      throw AppError.conflict('The job was changed by someone else. Reload and try again.');
    await tx.jobStatusEvent.create({
      data: {
        tenantId,
        transportJobId: id,
        fromStatus: job.status,
        toStatus: to,
        note: note ?? null,
        actorUserId: userId,
      },
    });
    await audit(
      tx,
      {
        tenantId,
        actorUserId: userId,
        action: 'job.status_changed',
        entityType: 'TransportJob',
        entityId: id,
        metadata: { from: job.status, to },
      },
      req,
    );
  });
  return getJob(tenantId, id);
}
