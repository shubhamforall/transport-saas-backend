import { Router } from 'express';
import { requireAuth } from '../../middleware/auth.js';
import { requirePermission, requireTenantMember } from '../../middleware/tenant.js';
import { createTenantSchema, updateTenantSchema } from './tenants.schemas.js';
import { createTenant, getTenant, listMyTenants, updateTenant } from './tenants.service.js';
import { customersRouter } from '../customers/customers.routes.js';
import { vehiclesRouter } from '../vehicles/vehicles.routes.js';
import { jobsRouter } from '../jobs/jobs.routes.js';
import { invoicesRouter } from '../invoices/invoices.routes.js';
import { paymentsRouter } from '../payments/payments.routes.js';
import { reportsRouter } from '../reports/reports.routes.js';
import { teamRouter } from '../team/team.routes.js';
import { subscriptionRouter } from '../subscriptions/subscriptions.routes.js';
import { requireWritableSubscription } from '../../services/subscriptions.js';

export const tenantsRouter = Router();

tenantsRouter.use(requireAuth);

tenantsRouter.post('/', async (req, res) => {
  const input = createTenantSchema.parse(req.body);
  res.status(201).json(await createTenant(req.auth!.userId, input, req));
});

tenantsRouter.get('/', async (req, res) => {
  res.json({ items: await listMyTenants(req.auth!.userId) });
});

/** Every route below is scoped to a membership the server has verified. */
export const tenantScoped = Router({ mergeParams: true });
tenantScoped.use(requireTenantMember);
// Lapsed subscriptions make the company read-only (billing routes stay open).
tenantScoped.use(requireWritableSubscription);

tenantScoped.get('/', requirePermission('tenant.read'), async (req, res) => {
  const { tenantId, role } = req.membership!;
  res.json(await getTenant(tenantId, role));
});

tenantScoped.patch('/', requirePermission('tenant.update'), async (req, res) => {
  const input = updateTenantSchema.parse(req.body);
  const { tenantId, role } = req.membership!;
  res.json(await updateTenant(tenantId, role, req.auth!.userId, input, req));
});

// Feature modules. Each router checks its own permissions.
tenantScoped.use('/customers', customersRouter);
tenantScoped.use('/vehicles', vehiclesRouter);
tenantScoped.use('/jobs', jobsRouter);
tenantScoped.use('/invoices', invoicesRouter);
tenantScoped.use('/payments', paymentsRouter);
tenantScoped.use('/', reportsRouter);
tenantScoped.use('/', teamRouter);
tenantScoped.use('/', subscriptionRouter);

tenantsRouter.use('/:tenantId', tenantScoped);
