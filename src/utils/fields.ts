import { z } from 'zod';

/** Reusable Zod field rules shared by modules. Empty strings become null. */

export const GSTIN_REGEX = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/;

const blankToNull = (v: string) => (v === '' ? null : v);

export const optionalText = (max: number) =>
  z.string().trim().max(max).transform(blankToNull).nullish();

export const requiredText = (max: number, message: string) =>
  z.string().trim().min(1, message).max(max);

export const phoneField = z
  .string()
  .trim()
  .transform((v) => v.replace(/[\s-]/g, ''))
  .refine((v) => v === '' || /^\+?\d{7,15}$/.test(v), 'Enter a valid phone number')
  .transform(blankToNull)
  .nullish();

export const emailField = z
  .string()
  .trim()
  .toLowerCase()
  .max(254)
  .refine((v) => v === '' || z.email().safeParse(v).success, 'Enter a valid email address')
  .transform(blankToNull)
  .nullish();

export const gstinField = z
  .string()
  .trim()
  .toUpperCase()
  .refine((v) => v === '' || GSTIN_REGEX.test(v), 'Enter a valid 15-character GSTIN')
  .transform(blankToNull)
  .nullish();

export const postalCodeField = z
  .string()
  .trim()
  .refine((v) => v === '' || /^[1-9][0-9]{5}$/.test(v), 'Enter a valid 6-digit PIN code')
  .transform(blankToNull)
  .nullish();

export const stateCodeField = z
  .string()
  .trim()
  .refine((v) => v === '' || /^[0-9]{2}$/.test(v), 'State code must be 2 digits')
  .transform(blankToNull)
  .nullish();

/** Largest single money amount accepted: ₹1 crore, in paise. Totals stay inside 32-bit ints. */
export const MAX_AMOUNT_MINOR = 1_000_000_000;

/** Money in integer paise. Never floats. */
export const moneyMinor = z
  .number({ error: 'Enter an amount' })
  .int('Amount must be in whole paise')
  .min(0, 'Amount cannot be negative')
  .max(MAX_AMOUNT_MINOR, 'Amount is too large');

/** Quantity in thousandths (1.5 => 1500). */
export const quantityMilli = z.number().int().min(0).max(1_000_000_000);

/** GST rate in basis points: 0 to 100%. */
export const taxRateBps = z.number().int().min(0).max(10_000);

/** A calendar date "YYYY-MM-DD" stored as a DATE column. */
export const dateOnly = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Use the format YYYY-MM-DD')
  .transform((v, ctx) => {
    const d = new Date(`${v}T00:00:00.000Z`);
    if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== v) {
      ctx.addIssue({ code: 'custom', message: 'Enter a valid date' });
      return z.NEVER;
    }
    return d;
  });

export const optionalDateOnly = z
  .union([z.literal(''), z.null(), dateOnly])
  .transform((v) => (v === '' ? null : v))
  .optional();

/** Database id path parameter (cuid). */
export const idSchema = z.string().regex(/^[a-z0-9]{20,30}$/, 'Invalid id');

/** "YYYY-MM-DD" for a DATE column value. */
export function toDateOnly(d: Date | null | undefined): string | null {
  return d ? d.toISOString().slice(0, 10) : null;
}

/** Today's date in a time zone, as "YYYY-MM-DD". */
export function todayIn(timeZone: string, now = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone }).format(now);
}

/** Today's date in a time zone, as a DATE value (UTC midnight). */
export function todayDateIn(timeZone: string, now = new Date()): Date {
  return new Date(`${todayIn(timeZone, now)}T00:00:00.000Z`);
}

export function addDays(d: Date, days: number): Date {
  return new Date(d.getTime() + days * 86_400_000);
}
