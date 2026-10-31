import { Router } from 'express';
import { requirePermission } from '../../middleware/tenant.js';
import { idParam, tenantOf, userOf } from '../../utils/params.js';
import { createPaymentSchema, paymentListSchema, voidPaymentSchema } from './payments.schemas.js';
import { getPayment, listPayments, recordPayment, voidPayment } from './payments.service.js';

/** Mounted under /tenants/:tenantId/payments after requireTenantMember. */
export const paymentsRouter = Router({ mergeParams: true });

paymentsRouter.get('/', requirePermission('payments.read'), async (req, res) => {
  res.json(await listPayments(tenantOf(req), paymentListSchema.parse(req.query)));
});

paymentsRouter.post('/', requirePermission('payments.write'), async (req, res) => {
  const input = createPaymentSchema.parse(req.body);
  res.status(201).json(await recordPayment(tenantOf(req), userOf(req), input, req));
});

paymentsRouter.get('/:paymentId', requirePermission('payments.read'), async (req, res) => {
  res.json(await getPayment(tenantOf(req), idParam(req, 'paymentId', 'Payment')));
});

paymentsRouter.post('/:paymentId/void', requirePermission('payments.write'), async (req, res) => {
  const { reason } = voidPaymentSchema.parse(req.body);
  const id = idParam(req, 'paymentId', 'Payment');
  res.json(await voidPayment(tenantOf(req), userOf(req), id, reason, req));
});
