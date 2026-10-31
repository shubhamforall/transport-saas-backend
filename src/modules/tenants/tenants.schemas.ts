import { z } from 'zod';

/** GSTIN format check only; it does not prove the registration is real. */
export const GSTIN_REGEX = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/;

const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .transform((v) => (v === '' ? null : v))
    .nullish();

const phone = z
  .string()
  .trim()
  .transform((v) => v.replace(/[\s-]/g, ''))
  .refine((v) => v === '' || /^\+?\d{7,15}$/.test(v), 'Enter a valid phone number')
  .transform((v) => (v === '' ? null : v))
  .nullish();

const email = z
  .string()
  .trim()
  .toLowerCase()
  .max(254)
  .refine((v) => v === '' || z.email().safeParse(v).success, 'Enter a valid email address')
  .transform((v) => (v === '' ? null : v))
  .nullish();

const gstin = z
  .string()
  .trim()
  .toUpperCase()
  .refine((v) => v === '' || GSTIN_REGEX.test(v), 'Enter a valid 15-character GSTIN')
  .transform((v) => (v === '' ? null : v))
  .nullish();

const postalCode = z
  .string()
  .trim()
  .refine((v) => v === '' || /^[1-9][0-9]{5}$/.test(v), 'Enter a valid 6-digit PIN code')
  .transform((v) => (v === '' ? null : v))
  .nullish();

const stateCode = z
  .string()
  .trim()
  .refine((v) => v === '' || /^[0-9]{2}$/.test(v), 'State code must be 2 digits')
  .transform((v) => (v === '' ? null : v))
  .nullish();

const tenantFields = {
  legalName: optionalText(200),
  phone,
  email,
  addressLine1: optionalText(200),
  addressLine2: optionalText(200),
  city: optionalText(100),
  state: optionalText(100),
  postalCode,
  gstin,
  stateCode,
};

/** GSTIN starts with the state code, so the two must agree when both are given. */
function gstinMatchesState(v: { gstin?: string | null; stateCode?: string | null }) {
  return !v.gstin || !v.stateCode || v.gstin.startsWith(v.stateCode);
}
const GSTIN_STATE_ISSUE = {
  message: 'GSTIN does not match the selected state code',
  path: ['gstin'],
};

export const createTenantSchema = z
  .object({ name: z.string().trim().min(2, 'Enter your company name').max(120), ...tenantFields })
  .strict()
  .refine(gstinMatchesState, GSTIN_STATE_ISSUE);

/** Business settings (project plan section 19). Only on update; defaults apply at creation. */
const settingsFields = {
  jobNumberPrefix: z
    .string()
    .trim()
    .toUpperCase()
    .regex(/^[A-Z0-9/-]{1,10}$/, 'Use 1-10 letters, digits, "-" or "/"')
    .optional(),
  invoicePrefix: z
    .string()
    .trim()
    .toUpperCase()
    .regex(
      /^[A-Z0-9]{1,5}$/,
      'Use 1-5 letters or digits (invoice numbers are limited to 16 characters)',
    )
    .optional(),
  defaultPaymentTermsDays: z.number().int().min(0).max(365).optional(),
  defaultTaxRateBps: z.number().int().min(0).max(10_000).optional(),
  defaultSacCode: z
    .string()
    .trim()
    .refine((v) => v === '' || /^\d{4,8}$/.test(v), 'SAC code is 4 to 8 digits')
    .transform((v) => (v === '' ? null : v))
    .nullish(),
  invoiceTerms: optionalText(2000),
  paymentInstructions: optionalText(2000),
};

export const updateTenantSchema = z
  .object({
    name: z.string().trim().min(2, 'Enter your company name').max(120).optional(),
    ...tenantFields,
    ...settingsFields,
  })
  .strict()
  .refine(gstinMatchesState, GSTIN_STATE_ISSUE)
  .refine((v) => Object.keys(v).length > 0, 'Nothing to update');

export type CreateTenantInput = z.infer<typeof createTenantSchema>;
export type UpdateTenantInput = z.infer<typeof updateTenantSchema>;
