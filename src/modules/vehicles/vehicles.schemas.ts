import { z } from 'zod';
import { optionalText } from '../../utils/fields.js';
import { listQuery } from '../../utils/list.js';

/** "mh 12-ab 1234" -> { display: "MH 12-AB 1234", normalized: "MH12AB1234" } */
export function normalizeRegistration(raw: string) {
  const display = raw.trim().toUpperCase().replace(/\s+/g, ' ');
  const normalized = display.replace(/[^A-Z0-9]/g, '');
  return { display, normalized };
}

const registration = z
  .string()
  .trim()
  .min(1, 'Enter the registration number')
  .max(20)
  .refine((v) => {
    const n = normalizeRegistration(v).normalized;
    return /^[A-Z0-9]{4,12}$/.test(n) && /[A-Z]/.test(n) && /[0-9]/.test(n);
  }, 'Enter a valid registration number, e.g. MH 12 AB 1234');

const fields = {
  registrationNumber: registration,
  vehicleType: z.enum([
    'MINI_TRUCK',
    'LCV',
    'MEDIUM_TRUCK',
    'HEAVY_TRUCK',
    'TRAILER',
    'CONTAINER_TRUCK',
    'PICKUP',
    'OTHER',
  ]),
  makeModel: optionalText(100),
  capacityMilli: z.number().int().min(0).max(1_000_000_000).nullish(),
  capacityUnit: z.enum(['TONNES', 'KG', 'CUBIC_METRES']).nullish(),
  ownershipType: z.enum(['OWNED', 'LEASED', 'ATTACHED', 'OTHER']).nullish(),
  notes: optionalText(2000),
};

export const createVehicleSchema = z.object(fields).strict();

export const updateVehicleSchema = z
  .object({
    ...fields,
    registrationNumber: registration.optional(),
    vehicleType: fields.vehicleType.optional(),
  })
  .strict()
  .refine((v) => Object.keys(v).length > 0, 'Nothing to update');

export const vehicleListSchema = listQuery(['registration', 'createdAt']).extend({
  status: z.enum(['ACTIVE', 'INACTIVE', 'ALL']).default('ACTIVE'),
  vehicleType: fields.vehicleType.optional(),
});

export type CreateVehicleInput = z.infer<typeof createVehicleSchema>;
export type UpdateVehicleInput = z.infer<typeof updateVehicleSchema>;
