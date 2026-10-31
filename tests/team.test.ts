import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { prisma } from '../src/services/prisma.js';
import { testOutbox } from '../src/services/mailer.js';
import {
  browserClient,
  ownerWithTenant,
  registerVerified,
  resetDb,
  signedInUser,
  uniqueEmail,
} from './helpers.js';

const app = createApp();

beforeAll(resetDb);
beforeEach(() => {
  testOutbox.length = 0;
});
afterAll(() => prisma.$disconnect());

const base = (tenantId: string) => `/api/v1/tenants/${tenantId}`;
const tokenFromOutbox = () =>
  decodeURIComponent(/token=([^\s&]+)/.exec(testOutbox.at(-1)!.text)![1]!);

const registerWith = (email: string) => registerVerified(app, email, 'Invited Person');

describe('invitations', () => {
  it('owner invites by email; invitee accepts and gets the role', async () => {
    const o = await ownerWithTenant(app, 'Deccan Roadways');
    const email = uniqueEmail('driver.manager');
    const inv = await o.post(`${base(o.tenantId)}/invitations`, {
      email: email.toUpperCase(),
      role: 'OPERATIONS',
    });
    expect(inv.status).toBe(201);
    expect(inv.body).toMatchObject({ email, role: 'OPERATIONS', emailSent: true });
    expect(JSON.stringify(inv.body)).not.toMatch(/token/i);
    expect(testOutbox[0]!.subject).toBe('Join Deccan Roadways on Vaharo');

    const token = tokenFromOutbox();
    const stored = await prisma.invitation.findFirstOrThrow({ where: { email } });
    expect(stored.tokenHash).not.toBe(token); // only the hash is stored

    const lookup = await (
      await browserClient(app)
    ).get(`/api/v1/invitations/lookup?token=${encodeURIComponent(token)}`);
    expect(lookup.body).toMatchObject({
      companyName: 'Deccan Roadways',
      email,
      role: 'OPERATIONS',
      expired: false,
    });

    const invitee = await registerWith(email);
    const accepted = await invitee.post('/api/v1/invitations/accept', { token });
    expect(accepted.status).toBe(200);
    expect(accepted.body.tenantId).toBe(o.tenantId);

    const me = await invitee.get('/api/v1/auth/me');
    expect(me.body.memberships[0]).toMatchObject({ tenantId: o.tenantId, role: 'OPERATIONS' });
    expect((await invitee.post('/api/v1/invitations/accept', { token })).status).toBe(400); // single use

    const members = await o.get(`${base(o.tenantId)}/members`);
    expect(members.body.members.map((m: { role: string }) => m.role).sort()).toEqual([
      'OPERATIONS',
      'OWNER',
    ]);
    expect(members.body.invitations).toHaveLength(0);
  });

  it('only the invited email can accept, and expired or revoked links fail', async () => {
    const o = await ownerWithTenant(app);
    const email = uniqueEmail('invitee');
    await o.post(`${base(o.tenantId)}/invitations`, { email, role: 'VIEWER' });
    const token = tokenFromOutbox();

    const stranger = await signedInUser(app);
    const wrong = await stranger.post('/api/v1/invitations/accept', { token });
    expect(wrong.status).toBe(403);
    expect(wrong.body.error.code).toBe('INVITATION_EMAIL_MISMATCH');

    await prisma.invitation.updateMany({
      where: { email },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });
    const invitee = await registerWith(email);
    expect((await invitee.post('/api/v1/invitations/accept', { token })).status).toBe(400);

    const again = await o.post(`${base(o.tenantId)}/invitations`, { email, role: 'VIEWER' });
    const token2 = tokenFromOutbox();
    await o.post(`${base(o.tenantId)}/invitations/${again.body.id}/revoke`);
    expect((await invitee.post('/api/v1/invitations/accept', { token: token2 })).status).toBe(400);
  });

  it('signing up from a valid invitation skips the email code; other tokens do not', async () => {
    const o = await ownerWithTenant(app, 'Invite Skip Co');
    const email = uniqueEmail('invited.skip');
    await o.post(`${base(o.tenantId)}/invitations`, { email, role: 'VIEWER' });
    const token = tokenFromOutbox();

    // A token for a different email does not verify this one.
    const other = await browserClient(app);
    const wrongEmail = await other.post('/api/v1/auth/register', {
      name: 'Not Invited',
      email: uniqueEmail('not.invited'),
      password: 'Str0ng-Passw0rd!',
      invitationToken: token,
    });
    expect(wrongEmail.status).toBe(202);

    const c = await browserClient(app);
    const reg = await c.post('/api/v1/auth/register', {
      name: 'Invited Person',
      email,
      password: 'Str0ng-Passw0rd!',
      invitationToken: token,
    });
    expect(reg.status).toBe(201);
    expect(reg.body.user.email).toBe(email);
    expect(testOutbox.some((m) => m.to === email && /verification code/.test(m.subject))).toBe(
      false,
    );
    expect((await prisma.user.findUniqueOrThrow({ where: { email } })).emailVerifiedAt).not.toBe(
      null,
    );
    expect((await c.post('/api/v1/invitations/accept', { token })).status).toBe(200);
  });

  it('cannot invite an existing member', async () => {
    const o = await ownerWithTenant(app);
    const res = await o.post(`${base(o.tenantId)}/invitations`, { email: o.email, role: 'VIEWER' });
    expect(res.status).toBe(409);
  });
});

describe('roles and privilege escalation', () => {
  async function companyWith(role: 'ADMIN' | 'OPERATIONS' | 'VIEWER') {
    const o = await ownerWithTenant(app);
    const member = await signedInUser(app);
    const m = await prisma.membership.create({
      data: { tenantId: o.tenantId, userId: member.userId, role },
    });
    const owner = await prisma.membership.findFirstOrThrow({
      where: { tenantId: o.tenantId, role: 'OWNER' },
    });
    return { o, member, membershipId: m.id, ownerMembershipId: owner.id };
  }

  it('a member cannot change their own role or make themselves Owner', async () => {
    const { o, member, membershipId } = await companyWith('ADMIN');
    expect(
      (await member.patch(`${base(o.tenantId)}/members/${membershipId}/role`, { role: 'OWNER' }))
        .status,
    ).toBe(403);
    expect(
      (await member.patch(`${base(o.tenantId)}/members/${membershipId}/role`, { role: 'ADMIN' }))
        .status,
    ).toBe(403);
    expect((await prisma.membership.findUniqueOrThrow({ where: { id: membershipId } })).role).toBe(
      'ADMIN',
    );
  });

  it('admin cannot touch the owner or invite admins/owners', async () => {
    const { o, member, ownerMembershipId } = await companyWith('ADMIN');
    expect(
      (
        await member.patch(`${base(o.tenantId)}/members/${ownerMembershipId}/role`, {
          role: 'VIEWER',
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await member.agent
          .delete(`${base(o.tenantId)}/members/${ownerMembershipId}`)
          .set('X-CSRF-Token', member.csrf)
      ).status,
    ).toBe(403);
    expect(
      (
        await member.post(`${base(o.tenantId)}/invitations`, {
          email: uniqueEmail(),
          role: 'ADMIN',
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await member.post(`${base(o.tenantId)}/invitations`, {
          email: uniqueEmail(),
          role: 'VIEWER',
        })
      ).status,
    ).toBe(201);
  });

  it('operations cannot administer the team or billing', async () => {
    const { o, member } = await companyWith('OPERATIONS');
    expect(
      (
        await member.post(`${base(o.tenantId)}/invitations`, {
          email: uniqueEmail(),
          role: 'VIEWER',
        })
      ).status,
    ).toBe(403);
    expect((await member.post(`${base(o.tenantId)}/subscription/cancel`)).status).toBe(403);
    expect(
      (await member.post(`${base(o.tenantId)}/subscription/checkout`, { planCode: 'x' })).status,
    ).toBe(403);
    const list = await member.get(`${base(o.tenantId)}/members`);
    expect(list.status).toBe(200);
    expect(list.body.invitations).toEqual([]); // pending invites are only shown to managers
  });

  it('owner changes roles and removes members; removed members lose access', async () => {
    const { o, member, membershipId } = await companyWith('VIEWER');
    expect(
      (await o.patch(`${base(o.tenantId)}/members/${membershipId}/role`, { role: 'ACCOUNTS' }))
        .status,
    ).toBe(204);
    expect(
      (
        await o.agent
          .delete(`${base(o.tenantId)}/members/${membershipId}`)
          .set('X-CSRF-Token', o.csrf)
      ).status,
    ).toBe(204);
    expect((await member.get(base(o.tenantId))).status).toBe(404);
    const logs = await prisma.auditLog.findMany({
      where: { entityId: membershipId },
      select: { action: true },
    });
    expect(logs.map((l) => l.action)).toEqual(['member.role_changed', 'member.removed']);
  });

  it('owner cannot remove themselves (company always keeps an owner)', async () => {
    const { o, ownerMembershipId } = await companyWith('VIEWER');
    const res = await o.agent
      .delete(`${base(o.tenantId)}/members/${ownerMembershipId}`)
      .set('X-CSRF-Token', o.csrf);
    expect(res.status).toBe(403);
  });

  it('ownership transfer needs the company name typed and swaps roles', async () => {
    const { o, member, membershipId, ownerMembershipId } = await companyWith('ADMIN');
    const bad = await o.post(`${base(o.tenantId)}/transfer-ownership`, {
      membershipId,
      confirmCompanyName: 'nope',
    });
    expect(bad.status).toBe(400);
    const ok = await o.post(`${base(o.tenantId)}/transfer-ownership`, {
      membershipId,
      confirmCompanyName: 'test transport co.',
    });
    expect(ok.status).toBe(204);
    expect((await prisma.membership.findUniqueOrThrow({ where: { id: membershipId } })).role).toBe(
      'OWNER',
    );
    expect(
      (await prisma.membership.findUniqueOrThrow({ where: { id: ownerMembershipId } })).role,
    ).toBe('ADMIN');
    // The old owner (now admin) cannot transfer again.
    const again = await o.post(`${base(o.tenantId)}/transfer-ownership`, {
      membershipId: ownerMembershipId,
      confirmCompanyName: 'Test Transport Co.',
    });
    expect(again.status).toBe(403);
    void member;
  });
});
