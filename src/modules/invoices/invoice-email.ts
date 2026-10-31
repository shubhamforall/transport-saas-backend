import type { Request } from 'express';
import { z } from 'zod';
import { prisma } from '../../services/prisma.js';
import { audit } from '../../services/audit.js';
import { MailError, sendMail, simpleHtml } from '../../services/mailer.js';
import { renderInvoicePdf } from '../../pdf/invoice-pdf.js';
import { AppError } from '../../utils/app-error.js';
import { emailField, optionalText } from '../../utils/fields.js';
import { getInvoice } from './invoices.service.js';

export const emailInvoiceSchema = z
  .object({
    /** Defaults to the customer's billing email. */
    to: emailField,
    cc: z.array(z.email().max(254)).max(5).optional(),
    message: optionalText(1000),
  })
  .strict();

const inr = new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR' });
const money = (paise: number) => inr.format(paise / 100);

/** A send started this recently is treated as in progress (protects against double clicks). */
const IN_PROGRESS_WINDOW_MS = 2 * 60_000;
const MAX_ATTEMPTS = 2;

export async function emailInvoice(
  tenantId: string,
  userId: string,
  invoiceId: string,
  input: z.infer<typeof emailInvoiceSchema>,
  req: Request,
) {
  const inv = await getInvoice(tenantId, invoiceId);
  if (inv.status === 'DRAFT') {
    throw new AppError(409, 'INVOICE_IS_DRAFT', 'Issue the invoice before emailing it.');
  }
  if (inv.status === 'CANCELLED') {
    throw new AppError(409, 'INVOICE_CANCELLED', 'Cancelled invoices cannot be emailed.');
  }
  const to = input.to ?? inv.customer.email;
  if (!to) {
    throw AppError.badRequest('Validation failed', {
      to: ['This customer has no email. Enter a recipient.'],
    });
  }

  const recent = await prisma.emailLog.findFirst({
    where: {
      tenantId,
      invoiceId,
      status: 'SENDING',
      createdAt: { gt: new Date(Date.now() - IN_PROGRESS_WINDOW_MS) },
    },
  });
  if (recent) {
    throw new AppError(
      409,
      'EMAIL_IN_PROGRESS',
      'This invoice is already being sent. Please wait.',
    );
  }

  const subject = `Invoice ${inv.invoiceNumber} from ${inv.from.name}`;
  const log = await prisma.emailLog.create({
    data: {
      tenantId,
      invoiceId,
      kind: 'invoice',
      recipient: to,
      subject,
      createdByUserId: userId,
    },
  });

  const greeting = inv.billTo.contactPerson ? `Dear ${inv.billTo.contactPerson},` : 'Hello,';
  const paragraphs = [
    greeting,
    `Please find attached invoice ${inv.invoiceNumber} dated ${inv.invoiceDate} for ${money(inv.grandTotalMinor)}.`,
    inv.balanceMinor > 0
      ? `Amount due: ${money(inv.balanceMinor)}${inv.dueDate ? `, due by ${inv.dueDate}` : ''}.`
      : 'This invoice is fully paid. Thank you.',
    ...(input.message ? [input.message] : []),
    ...(inv.from.paymentInstructions ? [`Payment details:\n${inv.from.paymentInstructions}`] : []),
    `Regards,\n${inv.from.name}`,
  ];
  const pdf = await renderInvoicePdf(inv);
  const filename = `${(inv.invoiceNumber ?? 'invoice').replace(/[^A-Za-z0-9-]/g, '-')}.pdf`;

  let attempts = 0;
  let lastError: string | null = null;
  let messageId: string | null = null;
  while (attempts < MAX_ATTEMPTS) {
    attempts += 1;
    try {
      ({ messageId } = await sendMail({
        to,
        cc: input.cc,
        subject,
        text: paragraphs.join('\n\n'),
        html: simpleHtml(paragraphs),
        attachments: [{ filename, content: pdf, contentType: 'application/pdf' }],
      }));
      lastError = null;
      break;
    } catch (err) {
      lastError = err instanceof MailError ? err.safeMessage : 'Email could not be sent.';
    }
  }

  const sent = lastError === null;
  const updated = await prisma.$transaction(async (tx) => {
    const row = await tx.emailLog.update({
      where: { id: log.id },
      data: {
        status: sent ? 'SENT' : 'FAILED',
        attemptCount: attempts,
        providerMessageId: messageId,
        lastErrorSafe: lastError,
        sentAt: sent ? new Date() : null,
      },
    });
    if (sent) {
      await tx.invoice.update({ where: { id: invoiceId }, data: { lastEmailedAt: new Date() } });
    }
    await audit(
      tx,
      {
        tenantId,
        actorUserId: userId,
        action: sent ? 'invoice.emailed' : 'invoice.email_failed',
        entityType: 'Invoice',
        entityId: invoiceId,
        metadata: { emailLogId: log.id },
      },
      req,
    );
    return row;
  });

  if (!sent) {
    throw new AppError(502, 'EMAIL_FAILED', lastError ?? 'Email could not be sent.');
  }
  return updated;
}

export async function listEmailLogs(tenantId: string, invoiceId: string) {
  const inv = await prisma.invoice.findFirst({
    where: { id: invoiceId, tenantId },
    select: { id: true },
  });
  if (!inv) throw AppError.notFound('Invoice not found');
  const items = await prisma.emailLog.findMany({
    where: { tenantId, invoiceId },
    orderBy: { createdAt: 'desc' },
    take: 50,
    select: {
      id: true,
      recipient: true,
      subject: true,
      status: true,
      attemptCount: true,
      lastErrorSafe: true,
      sentAt: true,
      createdAt: true,
    },
  });
  return { items };
}
