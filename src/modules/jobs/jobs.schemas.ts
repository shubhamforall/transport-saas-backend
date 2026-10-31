import { z } from 'zod';
import {
  dateOnly,
  idSchema,
  moneyMinor,
  optionalDateOnly,
  optionalText,
  phoneField,
  quantityMilli,
  requiredText,
  taxRateBps,
} from '../../utils/fields.js';
import { listQuery } from '../../utils/list.js';

export const JOB_STATUSES = ['DRAFT', 'BOOKED', 'IN_TRANSIT', 'DELIVERED', 'CANCELLED'] as const;
export type JobStatusValue = (typeof JOB_STATUSES)[number];

/** Allowed status changes. Delivered can go back to In transit only while not invoiced. */
export const TRANSITIONS: Record<JobStatusValue, readonly JobStatusValue[]> = {
  DRAFT: ['BOOKED', 'CANCELLED'],
  BOOKED: ['IN_TRANSIT', 'DELIVERED', 'DRAFT', 'CANCELLED'],
  IN_TRANSIT: ['DELIVERED', 'BOOKED', 'CANCELLED'],
  DELIVERED: ['IN_TRANSIT'],
  CANCELLED: [],
};

export function canTransition(from: JobStatusValue, to: JobStatusValue): boolean {
  return TRANSITIONS[from].includes(to);
}

const charge = z.object({
  description: requiredText(200, 'Describe the charge'),
  amountMinor: moneyMinor,
});

const fields = {
  customerId: idSchema,
  vehicleId: idSchema.nullish(),
  bookingDate: dateOnly,
  originAddress: optionalText(300),
  originCity: requiredText(100, 'Enter the pickup city'),
  destinationAddress: optionalText(300),
  destinationCity: requiredText(100, 'Enter the delivery city'),
  plannedPickupDate: optionalDateOnly,
  actualPickupDate: optionalDateOnly,
  plannedDeliveryDate: optionalDateOnly,
  actualDeliveryDate: optionalDateOnly,
  driverName: optionalText(120),
  driverPhone: phoneField,
  goodsDescription: requiredText(500, 'Describe the goods'),
  quantityMilli: quantityMilli.nullish(),
  quantityUnit: optionalText(20),
  lrNumber: optionalText(50),
  freightAmountMinor: moneyMinor,
  discountAmountMinor: moneyMinor.default(0),
  taxRateBps: taxRateBps.nullish(),
  internalNotes: optionalText(2000),
  charges: z.array(charge).max(20, 'Up to 20 extra charges').default([]),
};

type Amounts = {
  freightAmountMinor?: number;
  discountAmountMinor?: number;
  charges?: { amountMinor: number }[];
};

function discountWithinTotal(v: Amounts) {
  if (v.freightAmountMinor === undefined) return true;
  const gross = v.freightAmountMinor + (v.charges ?? []).reduce((s, c) => s + c.amountMinor, 0);
  return (v.discountAmountMinor ?? 0) <= gross;
}

function datesInOrder(v: {
  actualPickupDate?: Date | null;
  actualDeliveryDate?: Date | null;
  plannedPickupDate?: Date | null;
  plannedDeliveryDate?: Date | null;
}) {
  const ok = (a?: Date | null, b?: Date | null) => !a || !b || a <= b;
  return (
    ok(v.actualPickupDate, v.actualDeliveryDate) && ok(v.plannedPickupDate, v.plannedDeliveryDate)
  );
}

export const createJobSchema = z
  .object({ ...fields, status: z.enum(['DRAFT', 'BOOKED']).default('BOOKED') })
  .strict()
  .refine(discountWithinTotal, {
    message: 'Discount cannot be more than freight plus charges',
    path: ['discountAmountMinor'],
  })
  .refine(datesInOrder, {
    message: 'Delivery date cannot be before pickup date',
    path: ['actualDeliveryDate'],
  });

const { charges: _c, discountAmountMinor: _d, ...updatable } = fields;
export const updateJobSchema = z
  .object({
    ...Object.fromEntries(Object.entries(updatable).map(([k, v]) => [k, v.optional()])),
    discountAmountMinor: moneyMinor.optional(),
    charges: z.array(charge).max(20).optional(),
  } as { [K in keyof typeof updatable]: z.ZodOptional<(typeof updatable)[K]> } & {
    discountAmountMinor: z.ZodOptional<typeof moneyMinor>;
    charges: z.ZodOptional<z.ZodArray<typeof charge>>;
  })
  .strict()
  .refine((v) => Object.keys(v).length > 0, 'Nothing to update');

export const statusChangeSchema = z
  .object({
    status: z.enum(JOB_STATUSES),
    note: optionalText(500),
    /** Pickup/delivery date to record; defaults to today. */
    date: dateOnly.optional(),
  })
  .strict();

const csvStatuses = z
  .string()
  .transform((s) => s.split(',').filter(Boolean))
  .pipe(z.array(z.enum(JOB_STATUSES)));

export const jobListSchema = listQuery(['bookingDate', 'createdAt', 'jobNumber']).extend({
  status: csvStatuses.optional(),
  customerId: idSchema.optional(),
  vehicleId: idSchema.optional(),
  bookingFrom: dateOnly.optional(),
  bookingTo: dateOnly.optional(),
  deliveryFrom: dateOnly.optional(),
  deliveryTo: dateOnly.optional(),
  invoiced: z.enum(['yes', 'no']).optional(),
});

export const eligibleQuerySchema = z.object({ customerId: idSchema.optional() });

export type CreateJobInput = z.infer<typeof createJobSchema>;
export type UpdateJobInput = z.infer<typeof updateJobSchema>;
export type JobListQuery = z.infer<typeof jobListSchema>;
