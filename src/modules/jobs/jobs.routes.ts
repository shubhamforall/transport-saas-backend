import { Router } from 'express';
import { requirePermission } from '../../middleware/tenant.js';
import { idParam, tenantOf, userOf } from '../../utils/params.js';
import {
  createJobSchema,
  eligibleQuerySchema,
  jobListSchema,
  statusChangeSchema,
  updateJobSchema,
} from './jobs.schemas.js';
import {
  changeJobStatus,
  createJob,
  eligibleForInvoice,
  getJob,
  listJobs,
  updateJob,
} from './jobs.service.js';

/** Mounted under /tenants/:tenantId/jobs after requireTenantMember. */
export const jobsRouter = Router({ mergeParams: true });

jobsRouter.get('/', requirePermission('jobs.read'), async (req, res) => {
  res.json(await listJobs(tenantOf(req), jobListSchema.parse(req.query)));
});

// Before "/:jobId" so the path is not read as an id.
jobsRouter.get('/eligible-for-invoice', requirePermission('invoices.read'), async (req, res) => {
  const { customerId } = eligibleQuerySchema.parse(req.query);
  res.json(await eligibleForInvoice(tenantOf(req), customerId));
});

jobsRouter.post('/', requirePermission('jobs.write'), async (req, res) => {
  const input = createJobSchema.parse(req.body);
  res.status(201).json(await createJob(tenantOf(req), userOf(req), input, req));
});

jobsRouter.get('/:jobId', requirePermission('jobs.read'), async (req, res) => {
  res.json(await getJob(tenantOf(req), idParam(req, 'jobId', 'Job')));
});

jobsRouter.patch('/:jobId', requirePermission('jobs.write'), async (req, res) => {
  const input = updateJobSchema.parse(req.body);
  res.json(await updateJob(tenantOf(req), userOf(req), idParam(req, 'jobId', 'Job'), input, req));
});

jobsRouter.post('/:jobId/status', requirePermission('jobs.write'), async (req, res) => {
  const { status, note, date } = statusChangeSchema.parse(req.body);
  const id = idParam(req, 'jobId', 'Job');
  res.json(await changeJobStatus(tenantOf(req), userOf(req), id, status, note, date, req));
});
