import type { RequestHandler } from 'express';
import { z } from 'zod';
import { prisma } from '../services/prisma.js';
import { can, type Permission } from '../services/permissions.js';
import { AppError } from '../utils/app-error.js';

const tenantIdSchema = z.string().regex(/^[a-z0-9]{20,30}$/);

/**
 * Resolves `:tenantId` against the signed-in user's memberships. The id in the URL is only a
 * selector; access comes from an ACTIVE membership in an ACTIVE tenant. Non-members get 404 so
 * that tenant ids cannot be probed. Requires requireAuth first.
 */
export const requireTenantMember: RequestHandler = async (req, _res, next) => {
  if (!req.auth) return next(AppError.unauthorized());
  const parsed = tenantIdSchema.safeParse(req.params.tenantId);
  if (!parsed.success) return next(AppError.notFound('Company not found'));

  const membership = await prisma.membership.findUnique({
    where: { tenantId_userId: { tenantId: parsed.data, userId: req.auth.userId } },
    select: {
      id: true,
      tenantId: true,
      role: true,
      status: true,
      tenant: { select: { status: true } },
    },
  });
  if (!membership || membership.status !== 'ACTIVE') {
    return next(AppError.notFound('Company not found'));
  }
  if (membership.tenant.status !== 'ACTIVE') {
    return next(new AppError(403, 'TENANT_SUSPENDED', 'This company workspace is suspended.'));
  }

  req.membership = { id: membership.id, tenantId: membership.tenantId, role: membership.role };
  next();
};

/** Requires the current membership's role to grant the permission. Use after requireTenantMember. */
export function requirePermission(permission: Permission): RequestHandler {
  return (req, _res, next) => {
    if (!req.membership) return next(AppError.notFound('Company not found'));
    if (!can(req.membership.role, permission)) return next(AppError.forbidden());
    next();
  };
}
