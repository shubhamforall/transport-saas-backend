import type { Request } from 'express';
import type { MembershipRole, Prisma } from '../../generated/prisma/client.js';
import { prisma } from '../../services/prisma.js';
import { audit } from '../../services/audit.js';
import { permissionsFor } from '../../services/permissions.js';
import { startTrial } from '../../services/subscriptions.js';
import { AppError } from '../../utils/app-error.js';
import type { CreateTenantInput, UpdateTenantInput } from './tenants.schemas.js';

const tenantSelect = {
  id: true,
  name: true,
  legalName: true,
  phone: true,
  email: true,
  addressLine1: true,
  addressLine2: true,
  city: true,
  state: true,
  postalCode: true,
  country: true,
  gstin: true,
  stateCode: true,
  currency: true,
  timezone: true,
  status: true,
  jobNumberPrefix: true,
  invoicePrefix: true,
  defaultPaymentTermsDays: true,
  defaultTaxRateBps: true,
  defaultSacCode: true,
  invoiceTerms: true,
  paymentInstructions: true,
  createdAt: true,
  updatedAt: true,
} satisfies Prisma.TenantSelect;

type TenantRow = Prisma.TenantGetPayload<{ select: typeof tenantSelect }>;

function toDto(tenant: TenantRow, role: MembershipRole) {
  return { ...tenant, myRole: role, myPermissions: permissionsFor(role) };
}

/** Max companies one user may own. Stops runaway workspace creation; plans may change this later. */
export const MAX_OWNED_TENANTS = 5;

/** Creates a company and makes the caller its Owner, atomically. */
export async function createTenant(userId: string, input: CreateTenantInput, req: Request) {
  return prisma.$transaction(async (tx) => {
    const owned = await tx.membership.count({ where: { userId, role: 'OWNER', status: 'ACTIVE' } });
    if (owned >= MAX_OWNED_TENANTS) {
      throw new AppError(409, 'TENANT_LIMIT', `You can own up to ${MAX_OWNED_TENANTS} companies.`);
    }
    const tenant = await tx.tenant.create({ data: input, select: tenantSelect });
    const membership = await tx.membership.create({
      data: { tenantId: tenant.id, userId, role: 'OWNER' },
      select: { id: true },
    });
    await startTrial(tx, tenant.id);
    await audit(
      tx,
      {
        tenantId: tenant.id,
        actorUserId: userId,
        action: 'tenant.created',
        entityType: 'Tenant',
        entityId: tenant.id,
        metadata: { ownerMembershipId: membership.id },
      },
      req,
    );
    return toDto(tenant, 'OWNER');
  });
}

export async function listMyTenants(userId: string) {
  const memberships = await prisma.membership.findMany({
    where: { userId, status: 'ACTIVE', tenant: { status: 'ACTIVE' } },
    orderBy: { createdAt: 'asc' },
    select: { role: true, tenant: { select: tenantSelect } },
  });
  return memberships.map((m) => toDto(m.tenant, m.role));
}

/** tenantId must come from req.membership (already authorised), never straight from the URL. */
export async function getTenant(tenantId: string, role: MembershipRole) {
  const tenant = await prisma.tenant.findUnique({ where: { id: tenantId }, select: tenantSelect });
  if (!tenant) throw AppError.notFound('Company not found');
  return toDto(tenant, role);
}

export async function updateTenant(
  tenantId: string,
  role: MembershipRole,
  userId: string,
  input: UpdateTenantInput,
  req: Request,
) {
  return prisma.$transaction(async (tx) => {
    const before = await tx.tenant.findUnique({ where: { id: tenantId }, select: tenantSelect });
    if (!before) throw AppError.notFound('Company not found');

    // Validate GSTIN/state consistency against the merged record, not just the patch.
    const gstin = input.gstin !== undefined ? input.gstin : before.gstin;
    const stateCode = input.stateCode !== undefined ? input.stateCode : before.stateCode;
    if (gstin && stateCode && !gstin.startsWith(stateCode)) {
      throw AppError.badRequest('Validation failed', {
        gstin: ['GSTIN does not match the selected state code'],
      });
    }

    const tenant = await tx.tenant.update({
      where: { id: tenantId },
      data: input,
      select: tenantSelect,
    });
    await audit(
      tx,
      {
        tenantId,
        actorUserId: userId,
        action: 'tenant.updated',
        entityType: 'Tenant',
        entityId: tenantId,
        metadata: { fields: Object.keys(input) },
      },
      req,
    );
    return toDto(tenant, role);
  });
}
