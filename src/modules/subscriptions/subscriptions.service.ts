import type { Request } from 'express';
import { z } from 'zod';
import type { BillingInterval, Plan, SubscriptionStatus } from '../../generated/prisma/client.js';
import { env } from '../../config/env.js';
import { prisma } from '../../services/prisma.js';
import { audit } from '../../services/audit.js';
import { currentPlanLimits } from '../../services/plan-limits.js';
import {
  cancelRazorpaySubscription,
  createRazorpaySubscription,
  razorpayConfigured,
  verifyWebhookSignature,
} from '../../services/razorpay.js';
import { accessFor, currentSubscription } from '../../services/subscriptions.js';
import { AppError } from '../../utils/app-error.js';
import { logger } from '../../utils/logger.js';
import { isUniqueViolation } from '../../utils/prisma-errors.js';

export function planDto(p: Plan) {
  return {
    id: p.id,
    code: p.code,
    name: p.name,
    description: p.description,
    priceMinor: p.priceMinor,
    currency: p.currency,
    billingInterval: p.billingInterval,
    limits: p.limitsJson,
    features: p.featuresJson ?? [],
    isActive: p.isActive,
    sortOrder: p.sortOrder,
    onlineCheckout: Boolean(p.razorpayPlanId),
  };
}

export async function listActivePlans() {
  const plans = await prisma.plan.findMany({
    where: { isActive: true },
    orderBy: [{ sortOrder: 'asc' }, { priceMinor: 'asc' }],
  });
  return { items: plans.map(planDto) };
}

export async function getSubscriptionSummary(tenantId: string) {
  const [sub, pending, limits, vehicles, members, invites] = await Promise.all([
    currentSubscription(prisma, tenantId),
    prisma.subscription.findFirst({
      where: { tenantId, status: 'PENDING' },
      orderBy: { createdAt: 'desc' },
      include: { plan: true },
    }),
    currentPlanLimits(prisma, tenantId),
    prisma.vehicle.count({ where: { tenantId, status: 'ACTIVE' } }),
    prisma.membership.count({ where: { tenantId, status: 'ACTIVE' } }),
    prisma.invitation.count({
      where: { tenantId, acceptedAt: null, revokedAt: null, expiresAt: { gt: new Date() } },
    }),
  ]);
  const access = accessFor(sub);
  return {
    subscription: sub
      ? {
          id: sub.id,
          status: sub.status,
          provider: sub.provider,
          plan: planDto(sub.plan),
          trialEndsAt: sub.trialEndsAt,
          currentPeriodStart: sub.currentPeriodStart,
          currentPeriodEnd: sub.currentPeriodEnd,
          cancelAtPeriodEnd: sub.cancelAtPeriodEnd,
        }
      : null,
    pendingCheckout: pending ? { planCode: pending.plan.code, createdAt: pending.createdAt } : null,
    access,
    usage: { vehicles, users: members + invites },
    limits,
    onlinePaymentsAvailable: razorpayConfigured(),
  };
}

export const checkoutSchema = z.object({ planCode: z.string().min(1).max(40) }).strict();

const CYCLES: Record<BillingInterval, number> = { MONTHLY: 120, YEARLY: 10 };

/**
 * Starts a Razorpay subscription checkout. Access changes only when Razorpay's signed webhook
 * confirms payment; the browser's redirect or status never grants paid access.
 */
export async function startCheckout(
  tenantId: string,
  userId: string,
  planCode: string,
  req: Request,
) {
  const plan = await prisma.plan.findFirst({ where: { code: planCode, isActive: true } });
  if (!plan) throw AppError.badRequest('Validation failed', { planCode: ['Plan not found'] });
  if (!plan.razorpayPlanId) {
    throw new AppError(
      409,
      'PLAN_NOT_PURCHASABLE',
      'This plan cannot be bought online yet. Contact support.',
    );
  }
  const [tenant, user] = await Promise.all([
    prisma.tenant.findUniqueOrThrow({ where: { id: tenantId }, select: { name: true } }),
    prisma.user.findUniqueOrThrow({ where: { id: userId }, select: { name: true, email: true } }),
  ]);
  const rp = await createRazorpaySubscription(plan.razorpayPlanId, CYCLES[plan.billingInterval], {
    tenantId,
    planCode: plan.code,
  });
  const sub = await prisma.$transaction(async (tx) => {
    const row = await tx.subscription.create({
      data: {
        tenantId,
        planId: plan.id,
        provider: 'RAZORPAY',
        providerSubscriptionId: rp.id,
        status: 'PENDING',
      },
    });
    await audit(
      tx,
      {
        tenantId,
        actorUserId: userId,
        action: 'subscription.checkout_started',
        entityType: 'Subscription',
        entityId: row.id,
        metadata: { planCode: plan.code },
      },
      req,
    );
    return row;
  });
  return {
    provider: 'razorpay',
    keyId: env.RAZORPAY_KEY_ID,
    subscriptionId: rp.id,
    localSubscriptionId: sub.id,
    plan: planDto(plan),
    prefill: { name: user.name, email: user.email },
    companyName: tenant.name,
  };
}

export async function cancelSubscription(tenantId: string, userId: string, req: Request) {
  const sub = await currentSubscription(prisma, tenantId);
  if (!sub || ['CANCELLED', 'EXPIRED'].includes(sub.status)) {
    throw AppError.conflict('There is no active subscription to cancel.');
  }
  if (sub.provider === 'RAZORPAY' && sub.providerSubscriptionId) {
    // Stays active until the end of the paid period; the webhook records the final state.
    await cancelRazorpaySubscription(sub.providerSubscriptionId);
    await prisma.subscription.update({ where: { id: sub.id }, data: { cancelAtPeriodEnd: true } });
  } else {
    await prisma.subscription.update({
      where: { id: sub.id },
      data: {
        status: 'CANCELLED',
        currentPeriodEnd: sub.currentPeriodEnd ?? sub.trialEndsAt,
      },
    });
  }
  await audit(
    prisma,
    {
      tenantId,
      actorUserId: userId,
      action: 'subscription.cancel_requested',
      entityType: 'Subscription',
      entityId: sub.id,
    },
    req,
  );
  return getSubscriptionSummary(tenantId);
}

// ---- Webhooks -------------------------------------------------------------------------------

const EVENT_STATUS: Record<string, SubscriptionStatus> = {
  'subscription.activated': 'ACTIVE',
  'subscription.charged': 'ACTIVE',
  'subscription.resumed': 'ACTIVE',
  'subscription.pending': 'PAST_DUE',
  'subscription.halted': 'PAST_DUE',
  'subscription.paused': 'PAST_DUE',
  'subscription.cancelled': 'CANCELLED',
  'subscription.completed': 'EXPIRED',
};

interface RazorpayEvent {
  event?: string;
  payload?: {
    subscription?: {
      entity?: { id?: string; current_start?: number | null; current_end?: number | null };
    };
  };
}

const fromUnix = (s: number | null | undefined) => (s ? new Date(s * 1000) : undefined);

/**
 * Handles a Razorpay webhook: verify signature, store the event id (duplicates are ignored),
 * then apply the status change in one transaction. Returns what happened.
 */
export async function handleRazorpayWebhook(
  rawBody: Buffer,
  signature: string | undefined,
  eventIdHeader: string | undefined,
) {
  const secret = env.RAZORPAY_WEBHOOK_SECRET;
  if (!secret) throw new AppError(503, 'BILLING_NOT_CONFIGURED', 'Webhooks are not configured.');
  if (!verifyWebhookSignature(rawBody, signature, secret)) {
    throw new AppError(400, 'INVALID_SIGNATURE', 'Invalid webhook signature.');
  }
  let event: RazorpayEvent;
  try {
    event = JSON.parse(rawBody.toString('utf8')) as RazorpayEvent;
  } catch {
    throw AppError.badRequest('Malformed webhook body');
  }
  const eventType = String(event.event ?? 'unknown').slice(0, 100);
  const providerEventId = (eventIdHeader ?? '').slice(0, 100);
  if (!providerEventId) throw AppError.badRequest('Missing event id');

  let record: { id: string };
  try {
    record = await prisma.subscriptionWebhookEvent.create({
      data: { provider: 'RAZORPAY', providerEventId, eventType },
      select: { id: true },
    });
  } catch (err) {
    if (isUniqueViolation(err)) return { result: 'duplicate' as const };
    throw err;
  }

  const target = EVENT_STATUS[eventType];
  const entity = event.payload?.subscription?.entity;
  try {
    const result = await prisma.$transaction(async (tx) => {
      if (!target || !entity?.id) {
        await tx.subscriptionWebhookEvent.update({
          where: { id: record.id },
          data: { status: 'IGNORED', processedAt: new Date() },
        });
        return 'ignored' as const;
      }
      const sub = await tx.subscription.findUnique({
        where: { providerSubscriptionId: entity.id },
      });
      if (!sub) {
        await tx.subscriptionWebhookEvent.update({
          where: { id: record.id },
          data: { status: 'IGNORED', processedAt: new Date(), safeError: 'Unknown subscription' },
        });
        return 'ignored' as const;
      }
      await tx.subscription.update({
        where: { id: sub.id },
        data: {
          status: target,
          currentPeriodStart: fromUnix(entity.current_start),
          currentPeriodEnd: fromUnix(entity.current_end),
          ...(target === 'ACTIVE' && eventType !== 'subscription.charged'
            ? { cancelAtPeriodEnd: false }
            : {}),
        },
      });
      await tx.auditLog.create({
        data: {
          tenantId: sub.tenantId,
          action: 'subscription.status_changed',
          entityType: 'Subscription',
          entityId: sub.id,
          metadataJson: { from: sub.status, to: target, eventType, providerEventId },
        },
      });
      await tx.subscriptionWebhookEvent.update({
        where: { id: record.id },
        data: { status: 'PROCESSED', processedAt: new Date() },
      });
      return 'processed' as const;
    });
    return { result };
  } catch (err) {
    logger.error({ err, eventType }, 'Webhook processing failed');
    await prisma.subscriptionWebhookEvent.update({
      where: { id: record.id },
      data: { status: 'FAILED', safeError: 'Processing error' },
    });
    throw err;
  }
}
