import type { Request } from 'express';
import type { Prisma } from '../../generated/prisma/client.js';
import { prisma } from '../../services/prisma.js';
import { audit } from '../../services/audit.js';
import { AppError } from '../../utils/app-error.js';
import { toDateOnly } from '../../utils/fields.js';
import { paged, skipTake } from '../../utils/list.js';
import type { CreatePaymentInput, PaymentListQuery } from './payments.schemas.js';

const paymentInclude = {
  customer: { select: { id: true, name: true } },
  allocations: {
    include: { invoice: { select: { id: true, invoiceNumber: true, grandTotalMinor: true } } },
  },
} satisfies Prisma.PaymentInclude;

type PaymentRow = Prisma.PaymentGetPayload<{ include: typeof paymentInclude }>;

function toDto(p: PaymentRow) {
  return {
    ...p,
    paymentDate: toDateOnly(p.paymentDate),
    allocations: p.allocations.map((a) => ({
      invoiceId: a.invoiceId,
      invoiceNumber: a.invoice.invoiceNumber,
      allocatedAmountMinor: a.allocatedAmountMinor,
    })),
  };
}

const inr = new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR' });

/**
 * Records a customer payment against one invoice. The balance check and the increment are a
 * single conditional UPDATE, so concurrent payments can never over-pay an invoice.
 */
export async function recordPayment(
  tenantId: string,
  userId: string,
  input: CreatePaymentInput,
  req: Request,
) {
  const id = await prisma.$transaction(async (tx) => {
    const inv = await tx.invoice.findFirst({
      where: { id: input.invoiceId, tenantId },
      select: {
        id: true,
        status: true,
        grandTotalMinor: true,
        amountPaidMinor: true,
        customerId: true,
        invoiceNumber: true,
      },
    });
    if (!inv) throw AppError.badRequest('Validation failed', { invoiceId: ['Invoice not found'] });
    if (inv.status === 'DRAFT') {
      throw new AppError(409, 'INVOICE_IS_DRAFT', 'Issue the invoice before recording payments.');
    }
    if (inv.status === 'CANCELLED') {
      throw new AppError(
        409,
        'INVOICE_CANCELLED',
        'Payments cannot be recorded on a cancelled invoice.',
      );
    }
    const due = inv.grandTotalMinor - inv.amountPaidMinor;
    if (input.amountMinor > due) {
      throw new AppError(400, 'OVER_ALLOCATION', 'Payment is more than the balance due.', {
        amountMinor: [`Balance due is ${inr.format(due / 100)}`],
      });
    }

    const { count } = await tx.invoice.updateMany({
      where: {
        id: inv.id,
        tenantId,
        status: { in: ['ISSUED', 'PARTIALLY_PAID'] },
        amountPaidMinor: { lte: inv.grandTotalMinor - input.amountMinor },
      },
      data: { amountPaidMinor: { increment: input.amountMinor } },
    });
    if (count !== 1) {
      throw AppError.conflict('The invoice balance just changed. Reload and try again.');
    }
    const paid = inv.amountPaidMinor + input.amountMinor;
    await tx.invoice.update({
      where: { id: inv.id },
      data: { status: paid >= inv.grandTotalMinor ? 'PAID' : 'PARTIALLY_PAID' },
    });

    const payment = await tx.payment.create({
      data: {
        tenantId,
        customerId: inv.customerId,
        paymentDate: input.paymentDate,
        amountMinor: input.amountMinor,
        method: input.method,
        reference: input.reference ?? null,
        notes: input.notes ?? null,
        recordedByUserId: userId,
        allocations: { create: { invoiceId: inv.id, allocatedAmountMinor: input.amountMinor } },
      },
      select: { id: true },
    });
    await audit(
      tx,
      {
        tenantId,
        actorUserId: userId,
        action: 'payment.recorded',
        entityType: 'Payment',
        entityId: payment.id,
        metadata: {
          invoiceId: inv.id,
          invoiceNumber: inv.invoiceNumber,
          amountMinor: input.amountMinor,
        },
      },
      req,
    );
    return payment.id;
  });
  return getPayment(tenantId, id);
}

/** Voids a payment and gives the amount back to each invoice's balance. */
export async function voidPayment(
  tenantId: string,
  userId: string,
  id: string,
  reason: string,
  req: Request,
) {
  await prisma.$transaction(async (tx) => {
    const { count } = await tx.payment.updateMany({
      where: { id, tenantId, status: 'RECORDED' },
      data: { status: 'VOIDED', voidedAt: new Date(), voidedByUserId: userId, voidReason: reason },
    });
    if (count !== 1) {
      const exists = await tx.payment.findFirst({ where: { id, tenantId }, select: { id: true } });
      if (!exists) throw AppError.notFound('Payment not found');
      throw AppError.conflict('This payment is already voided.');
    }
    const allocations = await tx.paymentAllocation.findMany({ where: { tenantId, paymentId: id } });
    for (const a of allocations) {
      const inv = await tx.invoice.update({
        where: { id: a.invoiceId },
        data: { amountPaidMinor: { decrement: a.allocatedAmountMinor } },
        select: { amountPaidMinor: true, grandTotalMinor: true },
      });
      await tx.invoice.update({
        where: { id: a.invoiceId },
        data: {
          status:
            inv.amountPaidMinor <= 0
              ? 'ISSUED'
              : inv.amountPaidMinor >= inv.grandTotalMinor
                ? 'PAID'
                : 'PARTIALLY_PAID',
        },
      });
    }
    await audit(
      tx,
      {
        tenantId,
        actorUserId: userId,
        action: 'payment.voided',
        entityType: 'Payment',
        entityId: id,
        metadata: { reason, invoiceIds: allocations.map((a) => a.invoiceId) },
      },
      req,
    );
  });
  return getPayment(tenantId, id);
}

export async function getPayment(tenantId: string, id: string) {
  const p = await prisma.payment.findFirst({ where: { id, tenantId }, include: paymentInclude });
  if (!p) throw AppError.notFound('Payment not found');
  return toDto(p);
}

export async function listPayments(tenantId: string, q: PaymentListQuery) {
  const where: Prisma.PaymentWhereInput = {
    tenantId,
    ...(q.status !== 'ALL' ? { status: q.status } : {}),
    ...(q.customerId ? { customerId: q.customerId } : {}),
    ...(q.invoiceId ? { allocations: { some: { invoiceId: q.invoiceId } } } : {}),
    ...(q.method ? { method: q.method } : {}),
    ...(q.from || q.to ? { paymentDate: { gte: q.from, lte: q.to } } : {}),
    ...(q.q
      ? {
          OR: [
            { reference: { contains: q.q } },
            { customer: { name: { contains: q.q } } },
            { allocations: { some: { invoice: { invoiceNumber: { contains: q.q } } } } },
          ],
        }
      : {}),
  };
  const orderBy: Prisma.PaymentOrderByWithRelationInput[] =
    q.sort === 'paymentDate'
      ? [{ paymentDate: q.order }, { createdAt: q.order }]
      : q.sort === 'amount'
        ? [{ amountMinor: q.order }]
        : [{ createdAt: q.order }];
  const [rows, total] = await prisma.$transaction([
    prisma.payment.findMany({
      where,
      orderBy,
      include: paymentInclude,
      ...skipTake(q.page, q.pageSize),
    }),
    prisma.payment.count({ where }),
  ]);
  return paged(rows.map(toDto), total, q.page, q.pageSize);
}
