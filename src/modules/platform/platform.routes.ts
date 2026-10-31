import { Router, type RequestHandler } from 'express';
import { z } from 'zod';
import type { Prisma } from '../../generated/prisma/client.js';
import { requireAuth } from '../../middleware/auth.js';
import { prisma } from '../../services/prisma.js';
import { audit } from '../../services/audit.js';
import { accessFor } from '../../services/subscriptions.js';
import { AppError } from '../../utils/app-error.js';
import { dateOnly, idSchema, optionalText } from '../../utils/fields.js';
import { listQuery, paged, skipTake } from '../../utils/list.js';
import { idParam, userOf } from '../../utils/params.js';
import { isUniqueViolation } from '../../utils/prisma-errors.js';
import { planDto } from '../subscriptions/subscriptions.service.js';

/** Platform administrators only. Others get 404 so the area is not advertised. */
const requirePlatformAdmin: RequestHandler = (req, _res, next) => {
  if (!req.auth?.isPlatformAdmin) return next(AppError.notFound());
  next();
};

export const platformRouter = Router();
platformRouter.use(requireAuth, requirePlatformAdmin);

// ---- Tenants --------------------------------------------------------------------------------
// Super Admin sees company metadata and subscription state, never customer or invoice content.

const tenantListSchema = listQuery(['createdAt', 'name']).extend({
  status: z.enum(['ACTIVE', 'SUSPENDED', 'ALL']).default('ALL'),
});

const latestSub = {
  where: { status: { not: 'PENDING' as const } },
  orderBy: { createdAt: 'desc' as const },
  take: 1,
  include: { plan: { select: { code: true, name: true } } },
};

platformRouter.get('/tenants', async (req, res) => {
  const q = tenantListSchema.parse(req.query);
  const where: Prisma.TenantWhereInput = {
    ...(q.status !== 'ALL' ? { status: q.status } : {}),
    ...(q.q
      ? {
          OR: [
            { name: { contains: q.q } },
            { gstin: { contains: q.q.toUpperCase() } },
            { memberships: { some: { role: 'OWNER', user: { email: { contains: q.q } } } } },
          ],
        }
      : {}),
  };
  const [rows, total] = await prisma.$transaction([
    prisma.tenant.findMany({
      where,
      orderBy: q.sort === 'name' ? { name: q.order } : { createdAt: q.order },
      ...skipTake(q.page, q.pageSize),
      select: {
        id: true,
        name: true,
        status: true,
        statusReason: true,
        city: true,
        createdAt: true,
        _count: { select: { memberships: { where: { status: 'ACTIVE' } } } },
        memberships: {
          where: { role: 'OWNER', status: 'ACTIVE' },
          select: { user: { select: { name: true, email: true } } },
        },
        subscriptions: latestSub,
      },
    }),
    prisma.tenant.count({ where }),
  ]);
  const items = rows.map(({ _count, memberships, subscriptions, ...t }) => {
    const sub = subscriptions[0] ?? null;
    return {
      ...t,
      memberCount: _count.memberships,
      owners: memberships.map((m) => m.user),
      subscription: sub
        ? {
            status: sub.status,
            plan: sub.plan,
            trialEndsAt: sub.trialEndsAt,
            currentPeriodEnd: sub.currentPeriodEnd,
            access: accessFor(sub).mode,
          }
        : null,
    };
  });
  res.json(paged(items, total, q.page, q.pageSize));
});

platformRouter.get('/tenants/:tenantId', async (req, res) => {
  const id = idParam(req, 'tenantId', 'Company');
  const t = await prisma.tenant.findUnique({
    where: { id },
    select: {
      id: true,
      name: true,
      legalName: true,
      status: true,
      statusReason: true,
      city: true,
      state: true,
      gstin: true,
      createdAt: true,
      memberships: {
        where: { status: 'ACTIVE' },
        select: { role: true, createdAt: true, user: { select: { name: true, email: true } } },
      },
      subscriptions: {
        orderBy: { createdAt: 'desc' },
        take: 10,
        include: { plan: { select: { code: true, name: true } } },
      },
      _count: { select: { customers: true, vehicles: true, jobs: true, invoices: true } },
    },
  });
  if (!t) throw AppError.notFound('Company not found');
  const current = t.subscriptions.find((s) => s.status !== 'PENDING') ?? null;
  res.json({ ...t, access: accessFor(current) });
});

const statusSchema = z
  .object({ status: z.enum(['ACTIVE', 'SUSPENDED']), reason: z.string().trim().min(3).max(500) })
  .strict();

platformRouter.post('/tenants/:tenantId/status', async (req, res) => {
  const id = idParam(req, 'tenantId', 'Company');
  const { status, reason } = statusSchema.parse(req.body);
  await prisma.$transaction(async (tx) => {
    const t = await tx.tenant.findUnique({ where: { id }, select: { status: true } });
    if (!t) throw AppError.notFound('Company not found');
    await tx.tenant.update({ where: { id }, data: { status, statusReason: reason } });
    await audit(
      tx,
      {
        tenantId: id,
        actorUserId: userOf(req),
        action: 'platform.tenant_status_changed',
        entityType: 'Tenant',
        entityId: id,
        metadata: { from: t.status, to: status, reason },
      },
      req,
    );
  });
  res.status(204).end();
});

const manualSubSchema = z
  .object({
    planId: idSchema,
    status: z.enum(['TRIAL', 'ACTIVE', 'CANCELLED', 'EXPIRED']),
    /** Trial end or paid-until date. */
    until: dateOnly.optional(),
    reason: z.string().trim().min(3).max(500),
  })
  .strict();

/** Manual override (e.g. pilot customers paying offline). Always audited. */
platformRouter.post('/tenants/:tenantId/subscription', async (req, res) => {
  const tenantId = idParam(req, 'tenantId', 'Company');
  const input = manualSubSchema.parse(req.body);
  const sub = await prisma.$transaction(async (tx) => {
    const [t, plan] = await Promise.all([
      tx.tenant.findUnique({ where: { id: tenantId }, select: { id: true } }),
      tx.plan.findUnique({ where: { id: input.planId }, select: { id: true } }),
    ]);
    if (!t) throw AppError.notFound('Company not found');
    if (!plan) throw AppError.badRequest('Validation failed', { planId: ['Plan not found'] });
    const until = input.until ? new Date(input.until.getTime() + 86_399_000) : null;
    const row = await tx.subscription.create({
      data: {
        tenantId,
        planId: plan.id,
        provider: 'MANUAL',
        status: input.status,
        trialEndsAt: input.status === 'TRIAL' ? until : null,
        currentPeriodStart: input.status === 'ACTIVE' ? new Date() : null,
        currentPeriodEnd: input.status !== 'TRIAL' ? until : null,
      },
    });
    await audit(
      tx,
      {
        tenantId,
        actorUserId: userOf(req),
        action: 'platform.subscription_set',
        entityType: 'Subscription',
        entityId: row.id,
        metadata: {
          status: input.status,
          until: input.until?.toISOString() ?? null,
          reason: input.reason,
        },
      },
      req,
    );
    return row;
  });
  res.status(201).json(sub);
});

// ---- Plans ----------------------------------------------------------------------------------

const limitsSchema = z
  .object({
    maxUsers: z.number().int().min(1).max(10_000).optional(),
    maxVehicles: z.number().int().min(1).max(100_000).optional(),
  })
  .strict();

const planFields = {
  name: z.string().trim().min(2).max(80),
  description: optionalText(300),
  priceMinor: z.number().int().min(0).max(100_000_000),
  billingInterval: z.enum(['MONTHLY', 'YEARLY']),
  limits: limitsSchema,
  features: z.array(z.string().trim().min(1).max(120)).max(20).default([]),
  razorpayPlanId: z
    .string()
    .trim()
    .refine(
      (v) => v === '' || /^plan_[A-Za-z0-9]{6,40}$/.test(v),
      'Razorpay plan ids look like plan_XXXXXXXX',
    )
    .transform((v) => (v === '' ? null : v))
    .nullish(),
  isActive: z.boolean().default(true),
  sortOrder: z.number().int().min(0).max(1000).default(0),
};

const createPlanSchema = z
  .object({
    code: z
      .string()
      .trim()
      .toLowerCase()
      .regex(/^[a-z0-9-]{2,40}$/),
    ...planFields,
  })
  .strict();
const updatePlanSchema = z
  .object(
    Object.fromEntries(
      Object.entries(planFields).map(([k, v]) => [k, (v as z.ZodType).optional()]),
    ),
  )
  .strict();

platformRouter.get('/plans', async (_req, res) => {
  const plans = await prisma.plan.findMany({
    orderBy: [{ sortOrder: 'asc' }, { priceMinor: 'asc' }],
  });
  res.json({ items: plans.map(planDto) });
});

platformRouter.post('/plans', async (req, res) => {
  const { limits, features, ...input } = createPlanSchema.parse(req.body);
  try {
    const plan = await prisma.plan.create({
      data: { ...input, limitsJson: limits, featuresJson: features },
    });
    await audit(
      prisma,
      {
        actorUserId: userOf(req),
        action: 'platform.plan_created',
        entityType: 'Plan',
        entityId: plan.id,
        metadata: { code: plan.code },
      },
      req,
    );
    res.status(201).json(planDto(plan));
  } catch (err) {
    if (isUniqueViolation(err)) {
      throw new AppError(409, 'CONFLICT', 'A plan with this code exists.', {
        code: ['Code already used'],
      });
    }
    throw err;
  }
});

platformRouter.patch('/plans/:planId', async (req, res) => {
  const id = idParam(req, 'planId', 'Plan');
  const parsed = updatePlanSchema.parse(req.body) as Partial<
    z.infer<z.ZodObject<typeof planFields>>
  >;
  const { limits, features, ...rest } = parsed;
  const exists = await prisma.plan.findUnique({ where: { id }, select: { id: true } });
  if (!exists) throw AppError.notFound('Plan not found');
  const plan = await prisma.plan.update({
    where: { id },
    data: {
      ...rest,
      ...(limits ? { limitsJson: limits } : {}),
      ...(features ? { featuresJson: features } : {}),
    },
  });
  await audit(
    prisma,
    {
      actorUserId: userOf(req),
      action: 'platform.plan_updated',
      entityType: 'Plan',
      entityId: id,
      metadata: { fields: Object.keys(parsed) },
    },
    req,
  );
  res.json(planDto(plan));
});

// ---- Subscriptions, webhooks, audit ----------------------------------------------------------

platformRouter.get('/subscriptions', async (req, res) => {
  const q = listQuery(['createdAt'])
    .extend({
      status: z.enum(['TRIAL', 'PENDING', 'ACTIVE', 'PAST_DUE', 'CANCELLED', 'EXPIRED']).optional(),
    })
    .parse(req.query);
  const where: Prisma.SubscriptionWhereInput = {
    ...(q.status ? { status: q.status } : {}),
    ...(q.q ? { tenant: { name: { contains: q.q } } } : {}),
  };
  const [rows, total] = await prisma.$transaction([
    prisma.subscription.findMany({
      where,
      orderBy: { createdAt: q.order },
      ...skipTake(q.page, q.pageSize),
      include: {
        tenant: { select: { id: true, name: true } },
        plan: { select: { code: true, name: true } },
      },
    }),
    prisma.subscription.count({ where }),
  ]);
  res.json(paged(rows, total, q.page, q.pageSize));
});

platformRouter.get('/webhook-events', async (req, res) => {
  const q = listQuery(['receivedAt'])
    .extend({
      status: z.enum(['RECEIVED', 'PROCESSED', 'IGNORED', 'FAILED']).optional(),
    })
    .parse(req.query);
  const where: Prisma.SubscriptionWebhookEventWhereInput = q.status ? { status: q.status } : {};
  const [rows, total] = await prisma.$transaction([
    prisma.subscriptionWebhookEvent.findMany({
      where,
      orderBy: { receivedAt: q.order },
      ...skipTake(q.page, q.pageSize),
    }),
    prisma.subscriptionWebhookEvent.count({ where }),
  ]);
  res.json(paged(rows, total, q.page, q.pageSize));
});

/** Metadata is shown only for platform and subscription actions (no business content). */
platformRouter.get('/audit-logs', async (req, res) => {
  const q = listQuery(['createdAt'])
    .extend({
      tenantId: idSchema.optional(),
      action: z.string().trim().max(64).optional(),
    })
    .parse(req.query);
  const where: Prisma.AuditLogWhereInput = {
    ...(q.tenantId ? { tenantId: q.tenantId } : {}),
    ...(q.action ? { action: { startsWith: q.action } } : {}),
  };
  const [rows, total] = await prisma.$transaction([
    prisma.auditLog.findMany({
      where,
      orderBy: { createdAt: q.order },
      ...skipTake(q.page, q.pageSize),
      include: { tenant: { select: { name: true } } },
    }),
    prisma.auditLog.count({ where }),
  ]);
  const items = rows.map((r) => ({
    id: r.id,
    tenantId: r.tenantId,
    tenantName: r.tenant?.name ?? null,
    actorUserId: r.actorUserId,
    action: r.action,
    entityType: r.entityType,
    entityId: r.entityId,
    metadata:
      r.action.startsWith('platform.') || r.action.startsWith('subscription.')
        ? r.metadataJson
        : null,
    createdAt: r.createdAt,
  }));
  res.json(paged(items, total, q.page, q.pageSize));
});
