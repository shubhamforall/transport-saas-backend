import { Router } from 'express';
import { rateLimit } from 'express-rate-limit';
import { requirePermission } from '../../middleware/tenant.js';
import { renderInvoicePdf } from '../../pdf/invoice-pdf.js';
import { AppError } from '../../utils/app-error.js';
import { idParam, tenantOf, userOf } from '../../utils/params.js';
import { emailInvoice, emailInvoiceSchema, listEmailLogs } from './invoice-email.js';
import {
  cancelInvoiceSchema,
  createInvoiceSchema,
  invoiceListSchema,
  updateInvoiceSchema,
} from './invoices.schemas.js';
import {
  cancelInvoice,
  createInvoice,
  deleteDraft,
  getInvoice,
  issueInvoice,
  listInvoices,
  updateInvoice,
} from './invoices.service.js';

/** PDF generation is CPU-heavy; limit per IP. */
const pdfLimiter = rateLimit({
  windowMs: 60_000,
  limit: 60,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  handler: (_req, _res, next) =>
    next(
      new AppError(
        429,
        'TOO_MANY_REQUESTS',
        'Too many PDF downloads. Wait a minute and try again.',
      ),
    ),
});

/** Mounted under /tenants/:tenantId/invoices after requireTenantMember. */
export const invoicesRouter = Router({ mergeParams: true });

const invoiceId = (req: Parameters<typeof idParam>[0]) => idParam(req, 'invoiceId', 'Invoice');

invoicesRouter.get('/', requirePermission('invoices.read'), async (req, res) => {
  res.json(await listInvoices(tenantOf(req), invoiceListSchema.parse(req.query)));
});

invoicesRouter.post('/', requirePermission('invoices.write'), async (req, res) => {
  const input = createInvoiceSchema.parse(req.body);
  res.status(201).json(await createInvoice(tenantOf(req), userOf(req), input, req));
});

invoicesRouter.get('/:invoiceId', requirePermission('invoices.read'), async (req, res) => {
  res.json(await getInvoice(tenantOf(req), invoiceId(req)));
});

invoicesRouter.patch('/:invoiceId', requirePermission('invoices.write'), async (req, res) => {
  const input = updateInvoiceSchema.parse(req.body);
  res.json(await updateInvoice(tenantOf(req), userOf(req), invoiceId(req), input, req));
});

invoicesRouter.delete('/:invoiceId', requirePermission('invoices.write'), async (req, res) => {
  await deleteDraft(tenantOf(req), userOf(req), invoiceId(req), req);
  res.status(204).end();
});

invoicesRouter.post('/:invoiceId/issue', requirePermission('invoices.write'), async (req, res) => {
  res.json(await issueInvoice(tenantOf(req), userOf(req), invoiceId(req), req));
});

invoicesRouter.post('/:invoiceId/cancel', requirePermission('invoices.write'), async (req, res) => {
  const { reason } = cancelInvoiceSchema.parse(req.body);
  res.json(await cancelInvoice(tenantOf(req), userOf(req), invoiceId(req), reason, req));
});

const emailLimiter = rateLimit({
  windowMs: 60_000,
  limit: 10,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  handler: (_req, _res, next) =>
    next(new AppError(429, 'TOO_MANY_REQUESTS', 'Too many emails. Wait a minute and try again.')),
});

invoicesRouter.post(
  '/:invoiceId/email',
  requirePermission('invoices.write'),
  emailLimiter,
  async (req, res) => {
    const input = emailInvoiceSchema.parse(req.body);
    res.json(await emailInvoice(tenantOf(req), userOf(req), invoiceId(req), input, req));
  },
);

invoicesRouter.get(
  '/:invoiceId/email-logs',
  requirePermission('invoices.read'),
  async (req, res) => {
    res.json(await listEmailLogs(tenantOf(req), invoiceId(req)));
  },
);

invoicesRouter.get(
  '/:invoiceId/pdf',
  requirePermission('invoices.read'),
  pdfLimiter,
  async (req, res) => {
    const inv = await getInvoice(tenantOf(req), invoiceId(req));
    const pdf = await renderInvoicePdf(inv);
    const name = (inv.invoiceNumber ?? `draft-${inv.id}`).replace(/[^A-Za-z0-9-]/g, '-');
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="${name}.pdf"`);
    res.setHeader('Cache-Control', 'private, no-store');
    res.send(pdf);
  },
);
