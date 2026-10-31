import { z } from 'zod';
import {
  dateOnly,
  idSchema,
  moneyMinor,
  optionalDateOnly,
  optionalText,
  requiredText,
  stateCodeField,
  taxRateBps,
} from '../../utils/fields.js';
import { listQuery } from '../../utils/list.js';

export const itemSchema = z.object({
  description: requiredText(500, 'Describe the item'),
  sacCode: z
    .string()
    .trim()
    .refine((v) => v === '' || /^\d{4,8}$/.test(v), 'SAC/HSN code is 4 to 8 digits')
    .transform((v) => (v === '' ? null : v))
    .nullish(),
  quantityMilli: z.number().int().min(1, 'Quantity must be more than 0').max(10_000_000),
  unitPriceMinor: moneyMinor,
  discountMinor: moneyMinor.default(0),
  taxRateBps: taxRateBps.default(0),
});

const taxType = z.enum(['NONE', 'INTRA_STATE', 'INTER_STATE']);

const editable = {
  invoiceDate: dateOnly.optional(),
  dueDate: optionalDateOnly,
  taxType: taxType.optional(),
  placeOfSupplyStateCode: stateCodeField,
  items: z.array(itemSchema).max(100, 'Up to 100 lines').optional(),
  notes: optionalText(2000),
  terms: optionalText(2000),
};

export const createInvoiceSchema = z
  .object({
    ...editable,
    customerId: idSchema.optional(),
    /** Bill these delivered jobs. Lines are prefilled from the jobs unless items are given. */
    jobIds: z.array(idSchema).min(1).max(20).optional(),
  })
  .strict()
  .refine((v) => v.customerId || v.jobIds, {
    message: 'Choose a customer or a transport job',
    path: ['customerId'],
  });

export const updateInvoiceSchema = z
  .object({ ...editable, customerId: idSchema.optional() })
  .strict()
  .refine((v) => Object.keys(v).length > 0, 'Nothing to update');

export const cancelInvoiceSchema = z
  .object({ reason: z.string().trim().min(3, 'Give a reason for cancelling').max(500) })
  .strict();

const csv = <T extends readonly [string, ...string[]]>(values: T) =>
  z
    .string()
    .transform((s) => s.split(',').filter(Boolean))
    .pipe(z.array(z.enum(values)));

export const INVOICE_FILTER_STATUSES = [
  'DRAFT',
  'ISSUED',
  'PARTIALLY_PAID',
  'PAID',
  'CANCELLED',
  'OVERDUE',
] as const;

export const invoiceListSchema = listQuery([
  'invoiceDate',
  'createdAt',
  'grandTotal',
  'dueDate',
]).extend({
  status: csv(INVOICE_FILTER_STATUSES).optional(),
  customerId: idSchema.optional(),
  from: dateOnly.optional(),
  to: dateOnly.optional(),
});

export type ItemInput = z.infer<typeof itemSchema>;
export type CreateInvoiceInput = z.infer<typeof createInvoiceSchema>;
export type UpdateInvoiceInput = z.infer<typeof updateInvoiceSchema>;
export type InvoiceListQuery = z.infer<typeof invoiceListSchema>;
