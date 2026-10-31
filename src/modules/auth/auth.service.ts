import type { Request } from 'express';
import { Prisma } from '../../generated/prisma/client.js';
import { prisma } from '../../services/prisma.js';
import { audit } from '../../services/audit.js';
import { permissionsFor } from '../../services/permissions.js';
import { AppError } from '../../utils/app-error.js';
import type { LoginInput, RegisterInput } from './auth.schemas.js';
import { burnPasswordCheck, hashPassword, verifyPassword } from './password.js';
import { issueRefreshToken, signAccessToken } from './tokens.js';
import { sendVerificationCode } from './email-verification.js';
import { sha256 } from '../../utils/crypto.js';

export interface SessionTokens {
  accessToken: string;
  refreshToken: string;
}

const EMAIL_TAKEN = () =>
  new AppError(409, 'EMAIL_TAKEN', 'An account with this email already exists. Try signing in.', {
    email: ['An account with this email already exists'],
  });

/**
 * A pending team invitation for this email proves the person can read that inbox, so they can
 * skip the code.
 */
async function invitationProvesEmail(token: string | undefined, email: string) {
  if (!token) return false;
  const inv = await prisma.invitation.findUnique({
    where: { tokenHash: sha256(token) },
    select: {
      email: true,
      acceptedAt: true,
      revokedAt: true,
      expiresAt: true,
      tenant: { select: { status: true } },
    },
  });
  return Boolean(
    inv &&
    inv.email === email &&
    !inv.acceptedAt &&
    !inv.revokedAt &&
    inv.expiresAt > new Date() &&
    inv.tenant.status === 'ACTIVE',
  );
}

export type RegisterResult =
  | { verified: true; userId: string; refreshToken: string }
  | { verified: false; emailSent: boolean };

/**
 * New accounts must confirm their email with a 6-digit code before they can sign in.
 * An account that was never verified does not hold the email: registering again replaces it,
 * so nobody can block an address they do not own.
 */
export async function register(input: RegisterInput, req: Request): Promise<RegisterResult> {
  const passwordHash = await hashPassword(input.password);
  const viaInvitation = await invitationProvesEmail(input.invitationToken, input.email);
  const existing = await prisma.user.findUnique({
    where: { email: input.email },
    select: { id: true, emailVerifiedAt: true },
  });
  if (existing?.emailVerifiedAt) throw EMAIL_TAKEN();

  let user: { id: string; name: string; email: string };
  try {
    user = await prisma.$transaction(async (tx) => {
      const data = {
        name: input.name,
        passwordHash,
        emailVerifiedAt: viaInvitation ? new Date() : null,
      };
      const saved = existing
        ? await tx.user.update({
            // Conditional, so a concurrent verification of the old account is never overwritten.
            where: { id: existing.id, emailVerifiedAt: null },
            data,
            select: { id: true, name: true, email: true },
          })
        : await tx.user.create({
            data: { ...data, email: input.email },
            select: { id: true, name: true, email: true },
          });
      await audit(
        tx,
        {
          actorUserId: saved.id,
          action: existing ? 'user.registration_replaced' : 'user.registered',
          entityType: 'User',
          entityId: saved.id,
          metadata: viaInvitation ? { verifiedBy: 'invitation' } : undefined,
        },
        req,
      );
      return saved;
    });
  } catch (err) {
    if (
      err instanceof Prisma.PrismaClientKnownRequestError &&
      (err.code === 'P2002' || err.code === 'P2025')
    ) {
      throw EMAIL_TAKEN();
    }
    throw err;
  }

  if (viaInvitation) {
    return {
      verified: true,
      userId: user.id,
      refreshToken: await issueRefreshToken(prisma, user.id),
    };
  }
  const status = await sendVerificationCode(user, req, {
    // A double-click within a minute keeps the code already on its way.
    onCooldown: 'skip',
    onHourlyLimit: 'throw',
  });
  return { verified: false, emailSent: status !== 'failed' };
}

const INVALID_LOGIN = () =>
  new AppError(401, 'INVALID_CREDENTIALS', 'Email or password is incorrect.');

export async function login(input: LoginInput, req: Request) {
  const user = await prisma.user.findUnique({
    where: { email: input.email },
    select: {
      id: true,
      name: true,
      email: true,
      passwordHash: true,
      status: true,
      emailVerifiedAt: true,
    },
  });
  if (!user) {
    await burnPasswordCheck(input.password);
    throw INVALID_LOGIN();
  }
  const valid = await verifyPassword(input.password, user.passwordHash);
  if (!valid || user.status !== 'ACTIVE') throw INVALID_LOGIN();
  if (!user.emailVerifiedAt) {
    // Only after the right password, so this never reveals which emails are registered.
    await sendVerificationCode(user, req, { onCooldown: 'skip', onHourlyLimit: 'skip' });
    throw new AppError(
      403,
      'EMAIL_NOT_VERIFIED',
      'Please verify your email first. We have sent a code to your inbox.',
    );
  }

  const refreshToken = await issueRefreshToken(prisma, user.id);
  return { userId: user.id, refreshToken };
}

export async function createSession(userId: string, refreshToken: string): Promise<SessionTokens> {
  return { accessToken: await signAccessToken(userId), refreshToken };
}

/** The signed-in user plus the companies they can access. */
export async function getMe(userId: string) {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      id: true,
      name: true,
      email: true,
      isPlatformAdmin: true,
      memberships: {
        where: { status: 'ACTIVE', tenant: { status: 'ACTIVE' } },
        orderBy: { createdAt: 'asc' },
        select: { id: true, role: true, tenant: { select: { id: true, name: true } } },
      },
    },
  });
  if (!user) throw AppError.unauthorized();
  return {
    user: {
      id: user.id,
      name: user.name,
      email: user.email,
      isPlatformAdmin: user.isPlatformAdmin,
    },
    memberships: user.memberships.map((m) => ({
      membershipId: m.id,
      tenantId: m.tenant.id,
      tenantName: m.tenant.name,
      role: m.role,
      permissions: permissionsFor(m.role),
    })),
  };
}
