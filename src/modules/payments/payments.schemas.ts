import { z } from 'zod';
import { dateOnly, idSchema, moneyMinor, optionalText } from '../../utils/fields.js';
import { listQuery } from '../../utils/list.js';

export const PAYMENT_METHODS = ['CASH', 'BANK_TRANSFER', 'UPI', 'CHEQUE', 'OTHER'] as const;

export const createPaymentSchema = z
  .object({
    /** MVP: one payment pays one invoice (the model allows several allocations later). */
    invoiceId: idSchema,
    paymentDate: dateOnly,
    amountMinor: moneyMinor.refine((v) => v > 0, 'Amount must be more than zero'),
    method: z.enum(PAYMENT_METHODS),
    reference: optionalText(100),
    notes: optionalText(1000),
  })
  .strict();

export const voidPaymentSchema = z
  .object({ reason: z.string().trim().min(3, 'Give a reason').max(500) })
  .strict();

export const paymentListSchema = listQuery(['paymentDate', 'createdAt', 'amount']).extend({
  customerId: idSchema.optional(),
  invoiceId: idSchema.optional(),
  method: z.enum(PAYMENT_METHODS).optional(),
  status: z.enum(['RECORDED', 'VOIDED', 'ALL']).default('RECORDED'),
  from: dateOnly.optional(),
  to: dateOnly.optional(),
});

export type CreatePaymentInput = z.infer<typeof createPaymentSchema>;
export type PaymentListQuery = z.infer<typeof paymentListSchema>;
