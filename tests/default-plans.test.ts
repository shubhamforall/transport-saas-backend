import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { prisma } from '../src/services/prisma.js';
import { DEFAULT_PLANS, ensureDefaultPlans } from '../src/services/default-plans.js';
import { resetDb } from './helpers.js';

beforeAll(resetDb);
afterAll(() => prisma.$disconnect());

describe('default plans', () => {
  it('creates Starter, Growth and Business on a fresh install, once', async () => {
    expect(await ensureDefaultPlans()).toBe(3);
    const plans = await prisma.plan.findMany({ orderBy: { sortOrder: 'asc' } });
    expect(plans.map((p) => p.code)).toEqual(DEFAULT_PLANS.map((p) => p.code));
    expect(plans.every((p) => p.isActive)).toBe(true);
    expect(await ensureDefaultPlans()).toBe(0);
  });

  it('never touches plans the Super Admin changed or removed', async () => {
    await prisma.plan.update({ where: { code: 'growth' }, data: { priceMinor: 1_49_900 } });
    await prisma.plan.deleteMany({ where: { code: 'business' } });
    expect(await ensureDefaultPlans()).toBe(0);
    expect((await prisma.plan.findUniqueOrThrow({ where: { code: 'growth' } })).priceMinor).toBe(
      1_49_900,
    );
    expect(await prisma.plan.count({ where: { code: 'business' } })).toBe(0);
  });
});
