import { logger } from '../utils/logger.js';
import { prisma } from './prisma.js';

/**
 * Starting plans, created only when the plans table is empty (fresh install). After that the
 * Super Admin owns them: edits, deactivations and new plans are never overwritten.
 */
export const DEFAULT_PLANS = [
  {
    code: 'starter',
    name: 'Starter',
    description: 'For small fleets getting started.',
    priceMinor: 49_900,
    limitsJson: { maxUsers: 3, maxVehicles: 10 },
    featuresJson: ['Customers, vehicles and jobs', 'GST invoices with PDF', 'Email invoices'],
    sortOrder: 1,
  },
  {
    code: 'growth',
    name: 'Growth',
    description: 'For growing transport businesses.',
    priceMinor: 99_900,
    limitsJson: { maxUsers: 10, maxVehicles: 50 },
    featuresJson: ['Everything in Starter', 'Team roles', 'Reports'],
    sortOrder: 2,
  },
  {
    code: 'business',
    name: 'Business',
    description: 'Larger fleets, no limits.',
    priceMinor: 199_900,
    limitsJson: {},
    featuresJson: ['Everything in Growth', 'Unlimited users and vehicles'],
    sortOrder: 3,
  },
];

/** Returns how many plans were created (0 when any plan already exists). */
export async function ensureDefaultPlans() {
  if ((await prisma.plan.count()) > 0) return 0;
  const { count } = await prisma.plan.createMany({ data: DEFAULT_PLANS, skipDuplicates: true });
  if (count) logger.info({ count }, 'Created the default plans');
  return count;
}
