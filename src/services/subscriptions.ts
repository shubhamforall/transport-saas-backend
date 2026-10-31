import type { RequestHandler } from 'express';
import type { Prisma, Subscription } from '../generated/prisma/client.js';
import { env } from '../config/env.js';
import { AppError } from '../utils/app-error.js';
import { addDays } from '../utils/fields.js';
import { prisma } from './prisma.js';

type Db = Pick<Prisma.TransactionClient, 'subscription' | 'plan'>;

/**
 * The subscription that decides access: the newest one that is not a checkout still waiting
 * for payment (PENDING rows are in-progress checkouts).
 */
export function currentSubscription(
  db: Pick<Prisma.TransactionClient, 'subscription'>,
  tenantId: string,
) {
  return db.subscription.findFirst({
    where: { tenantId, status: { not: 'PENDING' } },
    orderBy: { createdAt: 'desc' },
    include: { plan: true },
  });
}

/** Starts the free trial on the first active plan. No plans configured = no subscription. */
export async function startTrial(db: Db, tenantId: string) {
  const plan = await db.plan.findFirst({
    where: { isActive: true },
    orderBy: [{ sortOrder: 'asc' }, { priceMinor: 'asc' }],
  });
  if (!plan) return null;
  return db.subscription.create({
    data: {
      tenantId,
      planId: plan.id,
      status: 'TRIAL',
      provider: 'NONE',
      trialEndsAt: addDays(new Date(), env.TRIAL_DAYS),
    },
  });
}

/**
 * Companies created while no plans existed have no subscription. Once plans exist, give them the
 * free trial they would have had (once only: any earlier subscription, even expired, blocks it).
 */
export async function ensureTrial(tenantId: string) {
  if ((await prisma.subscription.count({ where: { tenantId } })) > 0) return;
  if ((await prisma.plan.count({ where: { isActive: true } })) === 0) return;
  await prisma.$transaction(async (tx) => {
    // Lock the company row so two requests at once cannot both start a trial.
    await tx.$queryRaw`SELECT id FROM tenants WHERE id = ${tenantId} FOR UPDATE`;
    if ((await tx.subscription.count({ where: { tenantId } })) > 0) return;
    await startTrial(tx, tenantId);
  });
}

export type AccessMode = 'FULL' | 'READ_ONLY';

export interface Access {
  mode: AccessMode;
  /** Why access is limited, or when full access ends. */
  reason: string | null;
  fullAccessUntil: Date | null;
}

/**
 * Access policy (project plan 7.9). Lapsed subscriptions become read-only; data is never
 * deleted and can still be viewed and exported.
 *   TRIAL      full until trialEndsAt
 *   ACTIVE     full
 *   PAST_DUE   full for PAST_DUE_GRACE_DAYS after the period end, then read-only
 *   CANCELLED  full until the paid period (or trial) ends, then read-only
 *   EXPIRED    read-only
 */
export function accessFor(sub: Subscription | null, now = new Date()): Access {
  if (!sub) return { mode: 'FULL', reason: null, fullAccessUntil: null };
  const until = (d: Date | null): Access =>
    d && d > now
      ? { mode: 'FULL', reason: null, fullAccessUntil: d }
      : { mode: 'READ_ONLY', reason: 'Your subscription is not active.', fullAccessUntil: null };
  switch (sub.status) {
    case 'ACTIVE':
      return {
        mode: 'FULL',
        reason: null,
        fullAccessUntil: sub.cancelAtPeriodEnd ? sub.currentPeriodEnd : null,
      };
    case 'TRIAL': {
      const a = until(sub.trialEndsAt);
      return a.mode === 'FULL' ? a : { ...a, reason: 'Your free trial has ended.' };
    }
    case 'PAST_DUE': {
      const graceEnd = addDays(sub.currentPeriodEnd ?? sub.updatedAt, env.PAST_DUE_GRACE_DAYS);
      const a = until(graceEnd);
      return a.mode === 'FULL' ? a : { ...a, reason: 'Your last payment failed.' };
    }
    case 'CANCELLED': {
      const a = until(sub.currentPeriodEnd ?? sub.trialEndsAt);
      return a.mode === 'FULL' ? a : { ...a, reason: 'Your subscription was cancelled.' };
    }
    default:
      return { mode: 'READ_ONLY', reason: 'Your subscription has expired.', fullAccessUntil: null };
  }
}

const SAFE = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * Blocks changes when the company's subscription is read-only. Billing routes stay open so the
 * company can pay. Use after requireTenantMember.
 */
export const requireWritableSubscription: RequestHandler = async (req, _res, next) => {
  if (SAFE.has(req.method) || !req.membership) return next();
  if (req.path.startsWith('/subscription')) return next();
  const sub = await currentSubscription(prisma, req.membership.tenantId);
  const access = accessFor(sub);
  if (access.mode === 'READ_ONLY') {
    return next(
      new AppError(
        402,
        'SUBSCRIPTION_INACTIVE',
        `${access.reason} Your data is safe and can still be viewed. Choose a plan to make changes again.`,
      ),
    );
  }
  next();
};
