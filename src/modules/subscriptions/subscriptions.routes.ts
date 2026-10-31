import express, { Router } from 'express';
import { requirePermission } from '../../middleware/tenant.js';
import { tenantOf, userOf } from '../../utils/params.js';
import {
  cancelSubscription,
  checkoutSchema,
  getSubscriptionSummary,
  handleRazorpayWebhook,
  listActivePlans,
  startCheckout,
} from './subscriptions.service.js';

/** Mounted under /tenants/:tenantId after requireTenantMember. */
export const subscriptionRouter = Router({ mergeParams: true });

subscriptionRouter.get('/subscription', requirePermission('tenant.read'), async (req, res) => {
  res.json(await getSubscriptionSummary(tenantOf(req)));
});

subscriptionRouter.post(
  '/subscription/checkout',
  requirePermission('billing.manage'),
  async (req, res) => {
    const { planCode } = checkoutSchema.parse(req.body);
    res.json(await startCheckout(tenantOf(req), userOf(req), planCode, req));
  },
);

subscriptionRouter.post(
  '/subscription/cancel',
  requirePermission('billing.manage'),
  async (req, res) => {
    res.json(await cancelSubscription(tenantOf(req), userOf(req), req));
  },
);

/** Public plan list for the pricing / billing page. */
export const plansRouter = Router();
plansRouter.get('/', async (_req, res) => {
  res.json(await listActivePlans());
});

/**
 * Razorpay webhook. Registered before express.json() because the signature is computed over
 * the raw body. Not behind CSRF or login: the signature is the authentication.
 */
export const razorpayWebhook = [
  express.raw({ type: 'application/json', limit: '1mb' }),
  async (req: express.Request, res: express.Response) => {
    const body = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    const result = await handleRazorpayWebhook(
      body,
      req.header('x-razorpay-signature'),
      req.header('x-razorpay-event-id'),
    );
    res.json(result);
  },
] as const;
