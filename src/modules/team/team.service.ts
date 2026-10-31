import type { Request } from 'express';
import { z } from 'zod';
import type { MembershipRole, Prisma } from '../../generated/prisma/client.js';
import { env } from '../../config/env.js';
import { prisma } from '../../services/prisma.js';
import { audit } from '../../services/audit.js';
import { sendMail, simpleHtml } from '../../services/mailer.js';
import { enforcePlanLimit } from '../../services/plan-limits.js';
import { permissionsFor } from '../../services/permissions.js';
import { AppError } from '../../utils/app-error.js';
import { randomToken, sha256 } from '../../utils/crypto.js';
import { emailSchema } from '../auth/auth.schemas.js';

const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const ROLES = ['OWNER', 'ADMIN', 'OPERATIONS', 'ACCOUNTS', 'VIEWER'] as const;

/** Owner > Admin > everyone else. You can only manage people ranked below you. */
const RANK: Record<MembershipRole, number> = {
  OWNER: 3,
  ADMIN: 2,
  OPERATIONS: 1,
  ACCOUNTS: 1,
  VIEWER: 1,
};

export function canAssign(actor: MembershipRole, role: MembershipRole) {
  return RANK[role] < RANK[actor];
}
export function canManage(actor: MembershipRole, target: MembershipRole) {
  return RANK[target] < RANK[actor];
}

export const inviteSchema = z.object({ email: emailSchema, role: z.enum(ROLES) }).strict();
export const changeRoleSchema = z.object({ role: z.enum(ROLES) }).strict();
export const transferSchema = z
  .object({
    membershipId: z.string().min(1),
    /** Typed by the owner as an explicit confirmation. */
    confirmCompanyName: z.string().trim().min(1),
  })
  .strict();
export const tokenSchema = z.object({ token: z.string().min(20).max(200) });

type Actor = { userId: string; tenantId: string; role: MembershipRole; membershipId: string };

export async function listMembers(tenantId: string, includeInvitations: boolean) {
  const [members, invitations] = await Promise.all([
    prisma.membership.findMany({
      where: { tenantId, status: 'ACTIVE' },
      orderBy: { createdAt: 'asc' },
      select: {
        id: true,
        role: true,
        createdAt: true,
        user: { select: { id: true, name: true, email: true } },
      },
    }),
    includeInvitations
      ? prisma.invitation.findMany({
          where: { tenantId, acceptedAt: null, revokedAt: null },
          orderBy: { createdAt: 'desc' },
          select: { id: true, email: true, role: true, expiresAt: true, createdAt: true },
        })
      : Promise.resolve([]),
  ]);
  const now = new Date();
  return {
    members: members.map((m) => ({ ...m, permissions: permissionsFor(m.role) })),
    invitations: invitations.map((i) => ({ ...i, expired: i.expiresAt <= now })),
  };
}

async function sendInvitationEmail(
  tenantName: string,
  inviterName: string,
  email: string,
  role: MembershipRole,
  token: string,
) {
  const link = `${env.APP_BASE_URL.replace(/\/$/, '')}/invitations/accept?token=${encodeURIComponent(token)}`;
  const roleName = role.charAt(0) + role.slice(1).toLowerCase();
  const paragraphs = [
    'Hello,',
    `${inviterName} has invited you to join ${tenantName} on Vaharo as ${roleName}.`,
    'The invitation expires in 7 days. Sign in or create an account with this email address to accept it.',
  ];
  await sendMail({
    to: email,
    subject: `Join ${tenantName} on Vaharo`,
    text: `${paragraphs.join('\n\n')}\n\n${link}`,
    html: simpleHtml(paragraphs, { label: 'Accept invitation', url: link }),
  });
}

export async function invite(actor: Actor, input: z.infer<typeof inviteSchema>, req: Request) {
  if (!canAssign(actor.role, input.role)) {
    throw new AppError(403, 'FORBIDDEN', 'You cannot invite someone with this role.');
  }
  const token = randomToken();
  const result = await prisma.$transaction(async (tx) => {
    const existing = await tx.membership.findFirst({
      where: { tenantId: actor.tenantId, status: 'ACTIVE', user: { email: input.email } },
      select: { id: true },
    });
    if (existing) {
      throw new AppError(409, 'ALREADY_MEMBER', 'This person is already a member.', {
        email: ['Already a member of this company'],
      });
    }
    // Re-inviting replaces any pending invitation for the same email.
    await tx.invitation.updateMany({
      where: { tenantId: actor.tenantId, email: input.email, acceptedAt: null, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    await enforcePlanLimit(tx, actor.tenantId, 'maxUsers');
    const invitation = await tx.invitation.create({
      data: {
        tenantId: actor.tenantId,
        email: input.email,
        role: input.role,
        tokenHash: sha256(token),
        expiresAt: new Date(Date.now() + INVITE_TTL_MS),
        invitedByUserId: actor.userId,
      },
      select: { id: true, email: true, role: true, expiresAt: true, createdAt: true },
    });
    await audit(
      tx,
      {
        tenantId: actor.tenantId,
        actorUserId: actor.userId,
        action: 'invitation.created',
        entityType: 'Invitation',
        entityId: invitation.id,
        metadata: { role: input.role },
      },
      req,
    );
    const [tenant, inviter] = await Promise.all([
      tx.tenant.findUniqueOrThrow({ where: { id: actor.tenantId }, select: { name: true } }),
      tx.user.findUniqueOrThrow({ where: { id: actor.userId }, select: { name: true } }),
    ]);
    return { invitation, tenantName: tenant.name, inviterName: inviter.name };
  });

  let emailSent = true;
  try {
    await sendInvitationEmail(
      result.tenantName,
      result.inviterName,
      input.email,
      input.role,
      token,
    );
  } catch {
    emailSent = false;
  }
  await prisma.emailLog.create({
    data: {
      tenantId: actor.tenantId,
      kind: 'invitation',
      recipient: input.email,
      subject: `Join ${result.tenantName} on Vaharo`,
      status: emailSent ? 'SENT' : 'FAILED',
      attemptCount: 1,
      sentAt: emailSent ? new Date() : null,
      lastErrorSafe: emailSent ? null : 'Delivery failed',
      createdByUserId: actor.userId,
    },
  });
  return { ...result.invitation, expired: false, emailSent };
}

export async function revokeInvitation(actor: Actor, id: string, req: Request) {
  await prisma.$transaction(async (tx) => {
    const inv = await tx.invitation.findFirst({ where: { id, tenantId: actor.tenantId } });
    if (!inv) throw AppError.notFound('Invitation not found');
    if (!canAssign(actor.role, inv.role)) throw AppError.forbidden();
    if (inv.acceptedAt) throw AppError.conflict('This invitation was already accepted.');
    await tx.invitation.update({ where: { id }, data: { revokedAt: inv.revokedAt ?? new Date() } });
    await audit(
      tx,
      {
        tenantId: actor.tenantId,
        actorUserId: actor.userId,
        action: 'invitation.revoked',
        entityType: 'Invitation',
        entityId: id,
      },
      req,
    );
  });
}

async function loadTarget(tx: Prisma.TransactionClient, actor: Actor, membershipId: string) {
  const target = await tx.membership.findFirst({
    where: { id: membershipId, tenantId: actor.tenantId, status: 'ACTIVE' },
  });
  if (!target) throw AppError.notFound('Member not found');
  if (target.id === actor.membershipId) {
    throw new AppError(403, 'FORBIDDEN', 'You cannot change your own role or remove yourself.');
  }
  if (!canManage(actor.role, target.role)) {
    throw new AppError(403, 'FORBIDDEN', 'You cannot manage a member with this role.');
  }
  return target;
}

export async function changeRole(
  actor: Actor,
  membershipId: string,
  role: MembershipRole,
  req: Request,
) {
  if (!canAssign(actor.role, role)) {
    throw new AppError(
      403,
      'FORBIDDEN',
      'You cannot give this role. Use ownership transfer for Owner.',
    );
  }
  await prisma.$transaction(async (tx) => {
    const target = await loadTarget(tx, actor, membershipId);
    await tx.membership.update({ where: { id: target.id }, data: { role } });
    await audit(
      tx,
      {
        tenantId: actor.tenantId,
        actorUserId: actor.userId,
        action: 'member.role_changed',
        entityType: 'Membership',
        entityId: target.id,
        metadata: { from: target.role, to: role },
      },
      req,
    );
  });
}

/** Soft-removes a member; their history stays. Owners can never be removed this way. */
export async function removeMember(actor: Actor, membershipId: string, req: Request) {
  await prisma.$transaction(async (tx) => {
    const target = await loadTarget(tx, actor, membershipId);
    await tx.membership.update({ where: { id: target.id }, data: { status: 'REMOVED' } });
    await audit(
      tx,
      {
        tenantId: actor.tenantId,
        actorUserId: actor.userId,
        action: 'member.removed',
        entityType: 'Membership',
        entityId: target.id,
        metadata: { role: target.role },
      },
      req,
    );
  });
}

/** Owner hands the company to another active member and becomes an Admin. */
export async function transferOwnership(
  actor: Actor,
  input: z.infer<typeof transferSchema>,
  req: Request,
) {
  if (actor.role !== 'OWNER')
    throw new AppError(403, 'FORBIDDEN', 'Only the Owner can transfer ownership.');
  await prisma.$transaction(async (tx) => {
    const tenant = await tx.tenant.findUniqueOrThrow({
      where: { id: actor.tenantId },
      select: { name: true },
    });
    if (input.confirmCompanyName.trim().toLowerCase() !== tenant.name.trim().toLowerCase()) {
      throw AppError.badRequest('Validation failed', {
        confirmCompanyName: ['Type the company name exactly to confirm'],
      });
    }
    const target = await tx.membership.findFirst({
      where: { id: input.membershipId, tenantId: actor.tenantId, status: 'ACTIVE' },
    });
    if (!target) throw AppError.notFound('Member not found');
    if (target.id === actor.membershipId) throw AppError.badRequest('You are already the Owner.');
    await tx.membership.update({ where: { id: target.id }, data: { role: 'OWNER' } });
    await tx.membership.update({ where: { id: actor.membershipId }, data: { role: 'ADMIN' } });
    await audit(
      tx,
      {
        tenantId: actor.tenantId,
        actorUserId: actor.userId,
        action: 'tenant.ownership_transferred',
        entityType: 'Membership',
        entityId: target.id,
        metadata: { fromMembershipId: actor.membershipId, toMembershipId: target.id },
      },
      req,
    );
  });
}

async function findInvitation(token: string) {
  return prisma.invitation.findUnique({
    where: { tokenHash: sha256(token) },
    include: { tenant: { select: { id: true, name: true, status: true } } },
  });
}

/** Public: what an invitation link is for, so the accept page can explain it. */
export async function lookupInvitation(token: string) {
  const inv = await findInvitation(token);
  if (!inv || inv.revokedAt || inv.tenant.status !== 'ACTIVE') {
    throw new AppError(404, 'INVITATION_INVALID', 'This invitation is not valid.');
  }
  return {
    companyName: inv.tenant.name,
    email: inv.email,
    role: inv.role,
    expired: inv.expiresAt <= new Date(),
    accepted: Boolean(inv.acceptedAt),
  };
}

/** Accepts with the signed-in account; the account email must match the invitation. */
export async function acceptInvitation(userId: string, token: string, req: Request) {
  const inv = await findInvitation(token);
  const invalid = (msg = 'This invitation is not valid.') =>
    new AppError(400, 'INVITATION_INVALID', msg);
  if (!inv || inv.revokedAt || inv.tenant.status !== 'ACTIVE') throw invalid();
  if (inv.acceptedAt) throw invalid('This invitation was already used.');
  if (inv.expiresAt <= new Date()) throw invalid('This invitation has expired. Ask for a new one.');

  const user = await prisma.user.findUniqueOrThrow({
    where: { id: userId },
    select: { email: true },
  });
  if (user.email !== inv.email) {
    throw new AppError(
      403,
      'INVITATION_EMAIL_MISMATCH',
      `This invitation was sent to ${inv.email}. Sign in with that email to accept it.`,
    );
  }

  await prisma.$transaction(async (tx) => {
    const { count } = await tx.invitation.updateMany({
      where: { id: inv.id, acceptedAt: null, revokedAt: null },
      data: { acceptedAt: new Date(), acceptedUserId: userId },
    });
    if (count !== 1) throw invalid('This invitation was already used.');
    const existing = await tx.membership.findUnique({
      where: { tenantId_userId: { tenantId: inv.tenantId, userId } },
    });
    if (existing?.status === 'ACTIVE') {
      throw new AppError(409, 'ALREADY_MEMBER', 'You are already a member of this company.');
    }
    const membership = existing
      ? await tx.membership.update({
          where: { id: existing.id },
          data: { status: 'ACTIVE', role: inv.role },
        })
      : await tx.membership.create({ data: { tenantId: inv.tenantId, userId, role: inv.role } });
    await audit(
      tx,
      {
        tenantId: inv.tenantId,
        actorUserId: userId,
        action: 'invitation.accepted',
        entityType: 'Membership',
        entityId: membership.id,
        metadata: { invitationId: inv.id, role: inv.role },
      },
      req,
    );
  });
  return { tenantId: inv.tenantId, companyName: inv.tenant.name };
}
