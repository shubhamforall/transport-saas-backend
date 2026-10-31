import type { Request } from 'express';
import { Prisma } from '../../generated/prisma/client.js';
import { prisma } from '../../services/prisma.js';
import { audit } from '../../services/audit.js';
import { permissionsFor } from '../../services/permissions.js';
import { AppError } from '../../utils/app-error.js';
import type { LoginInput, RegisterInput } from './auth.schemas.js';
import { burnPasswordCheck, hashPassword, verifyPassword } from './password.js';
import { issueRefreshToken, signAccessToken } from './tokens.js';

export interface SessionTokens {
  accessToken: string;
  refreshToken: string;
}

export async function register(input: RegisterInput, req: Request) {
  const passwordHash = await hashPassword(input.password);
  try {
    return await prisma.$transaction(async (tx) => {
      const user = await tx.user.create({
        data: { name: input.name, email: input.email, passwordHash },
        select: { id: true },
      });
      await audit(
        tx,
        { actorUserId: user.id, action: 'user.registered', entityType: 'User', entityId: user.id },
        req,
      );
      const refreshToken = await issueRefreshToken(tx, user.id);
      return { userId: user.id, refreshToken };
    });
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
      throw new AppError(
        409,
        'EMAIL_TAKEN',
        'An account with this email already exists. Try signing in.',
        {
          email: ['An account with this email already exists'],
        },
      );
    }
    throw err;
  }
}

const INVALID_LOGIN = () =>
  new AppError(401, 'INVALID_CREDENTIALS', 'Email or password is incorrect.');

export async function login(input: LoginInput) {
  const user = await prisma.user.findUnique({
    where: { email: input.email },
    select: { id: true, passwordHash: true, status: true },
  });
  if (!user) {
    await burnPasswordCheck(input.password);
    throw INVALID_LOGIN();
  }
  const valid = await verifyPassword(input.password, user.passwordHash);
  if (!valid || user.status !== 'ACTIVE') throw INVALID_LOGIN();

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
