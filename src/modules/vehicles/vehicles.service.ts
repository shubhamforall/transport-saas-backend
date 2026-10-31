import type { Request } from 'express';
import type { z } from 'zod';
import type { Prisma } from '../../generated/prisma/client.js';
import { prisma } from '../../services/prisma.js';
import { audit } from '../../services/audit.js';
import { AppError } from '../../utils/app-error.js';
import { paged, skipTake } from '../../utils/list.js';
import { isUniqueViolation } from '../../utils/prisma-errors.js';
import {
  normalizeRegistration,
  type CreateVehicleInput,
  type UpdateVehicleInput,
  type vehicleListSchema,
} from './vehicles.schemas.js';

type ListQuery = z.infer<typeof vehicleListSchema>;

const DUPLICATE = () =>
  new AppError(409, 'CONFLICT', 'A vehicle with this registration number already exists.', {
    registrationNumber: ['This registration number is already in your fleet'],
  });

export async function listVehicles(tenantId: string, q: ListQuery) {
  const search = q.q ? normalizeRegistration(q.q).normalized : '';
  const where: Prisma.VehicleWhereInput = {
    tenantId,
    ...(q.status !== 'ALL' ? { status: q.status } : {}),
    ...(q.vehicleType ? { vehicleType: q.vehicleType } : {}),
    ...(q.q
      ? {
          OR: [
            ...(search ? [{ registrationNumberNormalized: { contains: search } }] : []),
            { makeModel: { contains: q.q } },
          ],
        }
      : {}),
  };
  const orderBy: Prisma.VehicleOrderByWithRelationInput =
    q.sort === 'registration' ? { registrationNumberNormalized: q.order } : { createdAt: q.order };
  const [items, total] = await prisma.$transaction([
    prisma.vehicle.findMany({ where, orderBy, ...skipTake(q.page, q.pageSize) }),
    prisma.vehicle.count({ where }),
  ]);
  return paged(items, total, q.page, q.pageSize);
}

export async function getVehicle(tenantId: string, id: string) {
  const vehicle = await prisma.vehicle.findFirst({
    where: { id, tenantId },
    include: { _count: { select: { jobs: true } } },
  });
  if (!vehicle) throw AppError.notFound('Vehicle not found');
  const { _count, ...rest } = vehicle;
  return { ...rest, jobCount: _count.jobs };
}

function toData(input: Partial<CreateVehicleInput>) {
  const { registrationNumber, ...rest } = input;
  if (registrationNumber === undefined) return rest;
  const { display, normalized } = normalizeRegistration(registrationNumber);
  return {
    ...rest,
    registrationNumberDisplay: display,
    registrationNumberNormalized: normalized,
  };
}

export async function createVehicle(
  tenantId: string,
  userId: string,
  input: CreateVehicleInput,
  req: Request,
  checkLimit?: (tx: Prisma.TransactionClient) => Promise<void>,
) {
  try {
    return await prisma.$transaction(async (tx) => {
      await checkLimit?.(tx);
      const vehicle = await tx.vehicle.create({
        data: { ...(toData(input) as Prisma.VehicleUncheckedCreateInput), tenantId },
      });
      await audit(
        tx,
        {
          tenantId,
          actorUserId: userId,
          action: 'vehicle.created',
          entityType: 'Vehicle',
          entityId: vehicle.id,
        },
        req,
      );
      return vehicle;
    });
  } catch (err) {
    if (isUniqueViolation(err)) throw DUPLICATE();
    throw err;
  }
}

export async function updateVehicle(
  tenantId: string,
  userId: string,
  id: string,
  input: UpdateVehicleInput,
  req: Request,
) {
  try {
    return await prisma.$transaction(async (tx) => {
      const { count } = await tx.vehicle.updateMany({
        where: { id, tenantId },
        data: toData(input),
      });
      if (count === 0) throw AppError.notFound('Vehicle not found');
      await audit(
        tx,
        {
          tenantId,
          actorUserId: userId,
          action: 'vehicle.updated',
          entityType: 'Vehicle',
          entityId: id,
          metadata: { fields: Object.keys(input) },
        },
        req,
      );
      return tx.vehicle.findUniqueOrThrow({ where: { id } });
    });
  } catch (err) {
    if (isUniqueViolation(err)) throw DUPLICATE();
    throw err;
  }
}

export async function setVehicleStatus(
  tenantId: string,
  userId: string,
  id: string,
  status: 'ACTIVE' | 'INACTIVE',
  req: Request,
) {
  return prisma.$transaction(async (tx) => {
    const { count } = await tx.vehicle.updateMany({ where: { id, tenantId }, data: { status } });
    if (count === 0) throw AppError.notFound('Vehicle not found');
    await audit(
      tx,
      {
        tenantId,
        actorUserId: userId,
        action: status === 'INACTIVE' ? 'vehicle.deactivated' : 'vehicle.activated',
        entityType: 'Vehicle',
        entityId: id,
      },
      req,
    );
    return tx.vehicle.findUniqueOrThrow({ where: { id } });
  });
}
