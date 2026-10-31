import { z } from 'zod';
import {
  emailField,
  gstinField,
  optionalText,
  phoneField,
  postalCodeField,
  stateCodeField,
} from '../../utils/fields.js';
import { listQuery } from '../../utils/list.js';

const fields = {
  customerType: z.enum(['BUSINESS', 'INDIVIDUAL']),
  name: z.string().trim().min(2, 'Enter the customer name').max(200),
  contactPerson: optionalText(120),
  email: emailField,
  phone: phoneField,
  addressLine1: optionalText(200),
  addressLine2: optionalText(200),
  city: optionalText(100),
  state: optionalText(100),
  stateCode: stateCodeField,
  postalCode: postalCodeField,
  gstin: gstinField,
  paymentTermsDays: z.number().int().min(0).max(365).nullish(),
  notes: optionalText(2000),
};

const gstinMatchesState = (v: { gstin?: string | null; stateCode?: string | null }) =>
  !v.gstin || !v.stateCode || v.gstin.startsWith(v.stateCode);
const GSTIN_STATE = { message: 'GSTIN does not match the selected state', path: ['gstin'] };

export const createCustomerSchema = z
  .object({ ...fields, customerType: fields.customerType.default('BUSINESS') })
  .strict()
  .refine(gstinMatchesState, GSTIN_STATE);

export const updateCustomerSchema = z
  .object({ ...fields, customerType: fields.customerType.optional(), name: fields.name.optional() })
  .strict()
  .refine(gstinMatchesState, GSTIN_STATE)
  .refine((v) => Object.keys(v).length > 0, 'Nothing to update');

export const customerListSchema = listQuery(['name', 'createdAt']).extend({
  status: z.enum(['ACTIVE', 'ARCHIVED', 'ALL']).default('ACTIVE'),
});

export type CreateCustomerInput = z.infer<typeof createCustomerSchema>;
export type UpdateCustomerInput = z.infer<typeof updateCustomerSchema>;
