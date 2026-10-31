import type { Prisma } from '../generated/prisma/client.js';
import { AppError } from '../utils/app-error.js';

export type LimitKey = 'maxVehicles' | 'maxUsers';

const LABELS: Record<LimitKey, string> = {
  maxVehicles: 'vehicles',
  maxUsers: 'team members',
};

/** Limits of the company's current plan. A missing key means unlimited. */
export async function currentPlanLimits(
  db: Pick<Prisma.TransactionClient, 'subscription'>,
  tenantId: string,
): Promise<Partial<Record<LimitKey, number>>> {
  // Same rule as access: pending checkouts do not count until paid.
  const sub = await db.subscription.findFirst({
    where: { tenantId, status: { not: 'PENDING' } },
    orderBy: { createdAt: 'desc' },
    select: { plan: { select: { limitsJson: true } } },
  });
  const raw = sub?.plan.limitsJson;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const out: Partial<Record<LimitKey, number>> = {};
  for (const key of ['maxVehicles', 'maxUsers'] as const) {
    const v = (raw as Record<string, unknown>)[key];
    if (typeof v === 'number' && Number.isInteger(v) && v >= 0) out[key] = v;
  }
  return out;
}

async function usage(tx: Prisma.TransactionClient, tenantId: string, key: LimitKey) {
  if (key === 'maxVehicles') {
    return tx.vehicle.count({ where: { tenantId, status: 'ACTIVE' } });
  }
  const [members, pending] = await Promise.all([
    tx.membership.count({ where: { tenantId, status: 'ACTIVE' } }),
    tx.invitation.count({
      where: { tenantId, acceptedAt: null, revokedAt: null, expiresAt: { gt: new Date() } },
    }),
  ]);
  return members + pending;
}

/** Throws 409 PLAN_LIMIT when adding one more would exceed the plan's limit. */
export async function enforcePlanLimit(
  tx: Prisma.TransactionClient,
  tenantId: string,
  key: LimitKey,
) {
  const limit = (await currentPlanLimits(tx, tenantId))[key];
  if (limit === undefined) return;
  if ((await usage(tx, tenantId, key)) >= limit) {
    throw new AppError(
      409,
      'PLAN_LIMIT',
      `Your plan allows up to ${limit} ${LABELS[key]}. Upgrade your plan to add more.`,
    );
  }
}
