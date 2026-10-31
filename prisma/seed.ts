/**
 * Development seed: SAMPLE data only. Refuses to run in production. Safe to run repeatedly.
 *
 *   npm run db:seed
 *
 * Creates illustrative plans (prices are placeholders, edit them in Super Admin), a platform
 * admin, and two companies with separate owners so tenant isolation can be tried by hand.
 */
import { env, isProduction } from '../src/config/env.js';
import { prisma } from '../src/services/prisma.js';
import { hashPassword } from '../src/modules/auth/password.js';
import { ensureSequence } from '../src/services/sequences.js';

if (isProduction) {
  console.error('Refusing to seed: NODE_ENV is production.');
  process.exit(1);
}

// `||` (not `??`): an empty SEED_DEMO_PASSWORD copied from .env.example must not mean "no password".
const DEMO_PASSWORD = process.env.SEED_DEMO_PASSWORD || 'Vaharo@Demo123';

const PLANS = [
  {
    code: 'starter',
    name: 'Starter',
    description: 'Illustrative price. For small fleets getting started.',
    priceMinor: 49_900,
    limitsJson: { maxUsers: 3, maxVehicles: 10 },
    featuresJson: ['Customers, vehicles and jobs', 'GST invoices with PDF', 'Email invoices'],
    sortOrder: 1,
  },
  {
    code: 'growth',
    name: 'Growth',
    description: 'Illustrative price. For growing transport businesses.',
    priceMinor: 99_900,
    limitsJson: { maxUsers: 10, maxVehicles: 50 },
    featuresJson: ['Everything in Starter', 'Team roles', 'Reports'],
    sortOrder: 2,
  },
  {
    code: 'business',
    name: 'Business',
    description: 'Illustrative price. Larger fleets, no limits.',
    priceMinor: 199_900,
    limitsJson: {},
    featuresJson: ['Everything in Growth', 'Unlimited users and vehicles'],
    sortOrder: 3,
  },
];

const companies = [
  {
    owner: { name: 'Demo Owner', email: 'owner@demo.vaharo.local' },
    tenant: {
      name: 'Patil Transport Co. (Sample)',
      legalName: 'Patil Transport Company (Sample Data)',
      addressLine1: 'Plot 12, MIDC Bhosari',
      city: 'Pune',
      state: 'Maharashtra',
      stateCode: '27',
      postalCode: '411026',
      gstin: '27ABCDE1234F1Z5',
      email: 'billing@patiltransport.example',
      defaultTaxRateBps: 1800,
      defaultSacCode: '996511',
      paymentInstructions: 'Sample bank details - replace before use.\nUPI: sample@upi',
    },
    sample: true,
  },
  {
    owner: { name: 'Second Owner', email: 'owner2@demo.vaharo.local' },
    tenant: {
      name: 'Sahyadri Logistics (Sample)',
      addressLine1: 'Fort',
      city: 'Mumbai',
      state: 'Maharashtra',
      stateCode: '27',
      postalCode: '400001',
    },
    sample: false,
  },
];

async function sampleRecords(tenantId: string, userId: string) {
  if ((await prisma.customer.count({ where: { tenantId } })) > 0) return;
  const abc = await prisma.customer.create({
    data: {
      tenantId,
      name: 'ABC Manufacturing Pvt. Ltd. (Sample)',
      contactPerson: 'Rahul Mehta',
      email: 'accounts@abc.example',
      phone: '+919876543210',
      addressLine1: 'Unit 4, Andheri East',
      city: 'Mumbai',
      state: 'Maharashtra',
      stateCode: '27',
      postalCode: '400069',
      gstin: '27AAACB1234C1Z5',
      paymentTermsDays: 30,
    },
  });
  await prisma.customer.create({
    data: {
      tenantId,
      name: 'XYZ Traders (Sample)',
      city: 'Nashik',
      stateCode: '27',
      state: 'Maharashtra',
    },
  });
  const truck = await prisma.vehicle.create({
    data: {
      tenantId,
      registrationNumberDisplay: 'MH 12 AB 1234',
      registrationNumberNormalized: 'MH12AB1234',
      vehicleType: 'HEAVY_TRUCK',
      makeModel: 'Tata Signa 3118 (Sample)',
      capacityMilli: 16_000,
      capacityUnit: 'TONNES',
      ownershipType: 'OWNED',
    },
  });
  await prisma.vehicle.create({
    data: {
      tenantId,
      registrationNumberDisplay: 'MH 14 CD 5678',
      registrationNumberNormalized: 'MH14CD5678',
      vehicleType: 'LCV',
      ownershipType: 'ATTACHED',
    },
  });
  await ensureSequence(tenantId, 'job');
  await prisma.tenantSequence.update({
    where: { tenantId_name: { tenantId, name: 'job' } },
    data: { nextNumber: 3 },
  });
  const today = new Date(`${new Date().toISOString().slice(0, 10)}T00:00:00.000Z`);
  await prisma.transportJob.create({
    data: {
      tenantId,
      jobNumber: 'JOB-0001',
      customerId: abc.id,
      vehicleId: truck.id,
      bookingDate: today,
      originCity: 'Mumbai',
      destinationCity: 'Pune',
      goodsDescription: 'Machine parts, 40 boxes (sample)',
      lrNumber: 'LR-1001',
      freightAmountMinor: 1_200_000,
      status: 'DELIVERED',
      actualPickupDate: today,
      actualDeliveryDate: today,
      createdByUserId: userId,
      charges: { create: [{ description: 'Loading', amountMinor: 50_000, sortOrder: 0 }] },
      statusEvents: { create: { toStatus: 'DELIVERED', actorUserId: userId, note: 'Sample data' } },
    },
  });
  await prisma.transportJob.create({
    data: {
      tenantId,
      jobNumber: 'JOB-0002',
      customerId: abc.id,
      bookingDate: today,
      originCity: 'Pune',
      destinationCity: 'Nashik',
      goodsDescription: 'Steel coils (sample)',
      freightAmountMinor: 1_500_000,
      status: 'BOOKED',
      createdByUserId: userId,
      statusEvents: { create: { toStatus: 'BOOKED', actorUserId: userId, note: 'Sample data' } },
    },
  });
}

async function main() {
  for (const p of PLANS) {
    await prisma.plan.upsert({ where: { code: p.code }, update: {}, create: p });
  }
  const growth = await prisma.plan.findUniqueOrThrow({ where: { code: 'growth' } });
  const passwordHash = await hashPassword(DEMO_PASSWORD);

  await prisma.user.upsert({
    where: { email: 'admin@demo.vaharo.local' },
    update: { isPlatformAdmin: true },
    create: {
      name: 'Platform Admin',
      email: 'admin@demo.vaharo.local',
      passwordHash,
      isPlatformAdmin: true,
    },
  });

  for (const { owner, tenant, sample } of companies) {
    const user = await prisma.user.upsert({
      where: { email: owner.email },
      update: {},
      create: { ...owner, passwordHash },
    });
    let membership = await prisma.membership.findFirst({
      where: { userId: user.id, role: 'OWNER', tenant: { name: tenant.name } },
    });
    if (!membership) {
      membership = await prisma.$transaction(async (tx) => {
        const t = await tx.tenant.create({ data: tenant });
        return tx.membership.create({ data: { tenantId: t.id, userId: user.id, role: 'OWNER' } });
      });
    } else {
      // Fill in details added in later milestones for companies seeded earlier.
      await prisma.tenant.update({ where: { id: membership.tenantId }, data: tenant });
    }
    const tenantId = membership.tenantId;
    if (!(await prisma.subscription.findFirst({ where: { tenantId } }))) {
      await prisma.subscription.create({
        data: {
          tenantId,
          planId: growth.id,
          status: 'TRIAL',
          trialEndsAt: new Date(Date.now() + 30 * 86_400_000),
        },
      });
    }
    if (sample) await sampleRecords(tenantId, user.id);
  }

  console.log(`Seeded sample data (${env.NODE_ENV}). Sign in with password ${DEMO_PASSWORD}:`);
  for (const { owner } of companies) console.log(`  ${owner.email}  (company owner)`);
  console.log('  admin@demo.vaharo.local  (Super Admin)');
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
