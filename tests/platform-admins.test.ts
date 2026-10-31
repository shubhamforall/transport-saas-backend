import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { PLATFORM_ADMIN_EMAILS } from '../src/config/platform-admins.js';
import { prisma } from '../src/services/prisma.js';
import { syncPlatformAdmins } from '../src/services/platform-admins.js';
import { hashPassword } from '../src/modules/auth/password.js';
import { PASSWORD, browserClient, registerVerified, resetDb, signedInUser } from './helpers.js';

const app = createApp();
const ADMIN_EMAIL = PLATFORM_ADMIN_EMAILS[0]!;

beforeAll(resetDb);
afterAll(() => prisma.$disconnect());

describe('built-in Super Admin list', () => {
  it('a listed email becomes Super Admin as soon as it is verified', async () => {
    const admin = await registerVerified(app, ADMIN_EMAIL, 'Owner Of Vaharo');
    const me = await admin.get('/api/v1/auth/me');
    expect(me.body.user.isPlatformAdmin).toBe(true);
    expect((await admin.get('/api/v1/platform/tenants')).status).toBe(200);
    expect(
      await prisma.auditLog.count({
        where: { actorUserId: admin.userId, action: 'platform.admin_granted_by_config' },
      }),
    ).toBe(1);
  });

  it('other users are never promoted', async () => {
    const user = await signedInUser(app);
    expect((await user.get('/api/v1/auth/me')).body.user.isPlatformAdmin).toBe(false);
    expect((await user.get('/api/v1/platform/tenants')).status).toBe(404);
  });

  it('an unverified account with the listed email gets nothing', async () => {
    await prisma.user.deleteMany({ where: { email: ADMIN_EMAIL } });
    const client = await browserClient(app);
    const reg = await client.post('/api/v1/auth/register', {
      name: 'Squatter',
      email: ADMIN_EMAIL,
      password: PASSWORD,
    });
    expect(reg.status).toBe(202);
    expect(await syncPlatformAdmins()).toBe(0);
    const stored = await prisma.user.findUniqueOrThrow({ where: { email: ADMIN_EMAIL } });
    expect(stored.isPlatformAdmin).toBe(false);
  });

  it('server start promotes an existing verified account, and repeating is harmless', async () => {
    await prisma.user.deleteMany({ where: { email: ADMIN_EMAIL } });
    await prisma.user.create({
      data: {
        name: 'Existing Owner',
        email: ADMIN_EMAIL,
        passwordHash: await hashPassword(PASSWORD),
        emailVerifiedAt: new Date(),
      },
    });
    expect(await syncPlatformAdmins()).toBe(1);
    expect(await syncPlatformAdmins()).toBe(0);
    const stored = await prisma.user.findUniqueOrThrow({ where: { email: ADMIN_EMAIL } });
    expect(stored.isPlatformAdmin).toBe(true);
  });

  it('sign-in promotes an existing verified account (e.g. after an admin was removed)', async () => {
    await prisma.user.update({ where: { email: ADMIN_EMAIL }, data: { isPlatformAdmin: false } });
    const client = await browserClient(app);
    const res = await client.post('/api/v1/auth/login', { email: ADMIN_EMAIL, password: PASSWORD });
    expect(res.status).toBe(200);
    expect(res.body.user.isPlatformAdmin).toBe(true);
  });
});
