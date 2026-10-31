import { Router } from 'express';
import { requirePermission } from '../../middleware/tenant.js';
import { idParam, tenantOf, userOf } from '../../utils/params.js';
import {
  createCustomerSchema,
  customerListSchema,
  updateCustomerSchema,
} from './customers.schemas.js';
import {
  createCustomer,
  getCustomer,
  listCustomers,
  setCustomerStatus,
  updateCustomer,
} from './customers.service.js';

/** Mounted under /tenants/:tenantId/customers after requireTenantMember. */
export const customersRouter = Router({ mergeParams: true });

customersRouter.get('/', requirePermission('customers.read'), async (req, res) => {
  res.json(await listCustomers(tenantOf(req), customerListSchema.parse(req.query)));
});

customersRouter.post('/', requirePermission('customers.write'), async (req, res) => {
  const input = createCustomerSchema.parse(req.body);
  res.status(201).json(await createCustomer(tenantOf(req), userOf(req), input, req));
});

customersRouter.get('/:customerId', requirePermission('customers.read'), async (req, res) => {
  res.json(await getCustomer(tenantOf(req), idParam(req, 'customerId', 'Customer')));
});

customersRouter.patch('/:customerId', requirePermission('customers.write'), async (req, res) => {
  const input = updateCustomerSchema.parse(req.body);
  const id = idParam(req, 'customerId', 'Customer');
  res.json(await updateCustomer(tenantOf(req), userOf(req), id, input, req));
});

customersRouter.post(
  '/:customerId/archive',
  requirePermission('customers.write'),
  async (req, res) => {
    const id = idParam(req, 'customerId', 'Customer');
    res.json(await setCustomerStatus(tenantOf(req), userOf(req), id, 'ARCHIVED', req));
  },
);

customersRouter.post(
  '/:customerId/restore',
  requirePermission('customers.write'),
  async (req, res) => {
    const id = idParam(req, 'customerId', 'Customer');
    res.json(await setCustomerStatus(tenantOf(req), userOf(req), id, 'ACTIVE', req));
  },
);
