import { Router } from 'express';
import { z } from 'zod';
import { requirePermission } from '../../middleware/tenant.js';
import { dateOnly } from '../../utils/fields.js';
import { tenantOf } from '../../utils/params.js';
import { dashboard, invoicesReport, jobsReport, receivablesReport } from './reports.service.js';

const rangeSchema = z
  .object({ from: dateOnly, to: dateOnly })
  .refine((r) => r.from <= r.to, { message: '"from" must be before "to"', path: ['from'] })
  .refine((r) => r.to.getTime() - r.from.getTime() <= 3 * 366 * 86_400_000, {
    message: 'Choose a range of up to 3 years',
    path: ['to'],
  });

/** Mounted under /tenants/:tenantId after requireTenantMember. */
export const reportsRouter = Router({ mergeParams: true });

reportsRouter.get('/dashboard', requirePermission('tenant.read'), async (req, res) => {
  res.json(await dashboard(tenantOf(req)));
});

reportsRouter.get('/reports/receivables', requirePermission('reports.read'), async (req, res) => {
  res.json(await receivablesReport(tenantOf(req)));
});

reportsRouter.get('/reports/jobs', requirePermission('reports.read'), async (req, res) => {
  const range = rangeSchema.safeParse(req.query);
  if (!range.success) throw range.error;
  res.json(await jobsReport(tenantOf(req), range.data));
});

reportsRouter.get('/reports/invoices', requirePermission('reports.read'), async (req, res) => {
  const range = rangeSchema.safeParse(req.query);
  if (!range.success) throw range.error;
  res.json(await invoicesReport(tenantOf(req), range.data));
});
