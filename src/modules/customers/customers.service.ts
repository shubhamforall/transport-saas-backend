import type { Request } from 'express';
import type { Prisma } from '../../generated/prisma/client.js';
import { prisma } from '../../services/prisma.js';
import { audit } from '../../services/audit.js';
import { AppError } from '../../utils/app-error.js';
import { paged, skipTake } from '../../utils/list.js';
import type { z } from 'zod';
import type {
  CreateCustomerInput,
  UpdateCustomerInput,
  customerListSchema,
} from './customers.schemas.js';

type ListQuery = z.infer<typeof customerListSchema>;

export async function listCustomers(tenantId: string, q: ListQuery) {
  const where: Prisma.CustomerWhereInput = {
    tenantId,
    ...(q.status !== 'ALL' ? { status: q.status } : {}),
    ...(q.q
      ? {
          OR: [
            { name: { contains: q.q } },
            { email: { contains: q.q } },
            { phone: { contains: q.q.replace(/[\s-]/g, '') } },
            { gstin: { contains: q.q.toUpperCase() } },
            { contactPerson: { contains: q.q } },
          ],
        }
      : {}),
  };
  const orderBy: Prisma.CustomerOrderByWithRelationInput =
    q.sort === 'name' ? { name: q.order } : { createdAt: q.order };
  const [items, total] = await prisma.$transaction([
    prisma.customer.findMany({ where, orderBy, ...skipTake(q.page, q.pageSize) }),
    prisma.customer.count({ where }),
  ]);
  return paged(items, total, q.page, q.pageSize);
}

/** Always scoped by tenantId: an id from another company is simply "not found". */
export async function getCustomer(tenantId: string, id: string) {
  const customer = await prisma.customer.findFirst({
    where: { id, tenantId },
    include: { _count: { select: { jobs: true, invoices: true } } },
  });
  if (!customer) throw AppError.notFound('Customer not found');
  const { _count, ...rest } = customer;
  return { ...rest, jobCount: _count.jobs, invoiceCount: _count.invoices };
}

export async function createCustomer(
  tenantId: string,
  userId: string,
  input: CreateCustomerInput,
  req: Request,
) {
  return prisma.$transaction(async (tx) => {
    const customer = await tx.customer.create({ data: { ...input, tenantId } });
    await audit(
      tx,
      {
        tenantId,
        actorUserId: userId,
        action: 'customer.created',
        entityType: 'Customer',
        entityId: customer.id,
      },
      req,
    );
    return customer;
  });
}

export async function updateCustomer(
  tenantId: string,
  userId: string,
  id: string,
  input: UpdateCustomerInput,
  req: Request,
) {
  return prisma.$transaction(async (tx) => {
    const before = await tx.customer.findFirst({ where: { id, tenantId } });
    if (!before) throw AppError.notFound('Customer not found');
    const gstin = input.gstin !== undefined ? input.gstin : before.gstin;
    const stateCode = input.stateCode !== undefined ? input.stateCode : before.stateCode;
    if (gstin && stateCode && !gstin.startsWith(stateCode)) {
      throw AppError.badRequest('Validation failed', {
        gstin: ['GSTIN does not match the selected state'],
      });
    }
    const customer = await tx.customer.update({ where: { id }, data: input });
    await audit(
      tx,
      {
        tenantId,
        actorUserId: userId,
        action: 'customer.updated',
        entityType: 'Customer',
        entityId: id,
        metadata: { fields: Object.keys(input) },
      },
      req,
    );
    return customer;
  });
}

export async function setCustomerStatus(
  tenantId: string,
  userId: string,
  id: string,
  status: 'ACTIVE' | 'ARCHIVED',
  req: Request,
) {
  return prisma.$transaction(async (tx) => {
    const { count } = await tx.customer.updateMany({ where: { id, tenantId }, data: { status } });
    if (count === 0) throw AppError.notFound('Customer not found');
    await audit(
      tx,
      {
        tenantId,
        actorUserId: userId,
        action: status === 'ARCHIVED' ? 'customer.archived' : 'customer.restored',
        entityType: 'Customer',
        entityId: id,
      },
      req,
    );
    return tx.customer.findUniqueOrThrow({ where: { id } });
  });
}
