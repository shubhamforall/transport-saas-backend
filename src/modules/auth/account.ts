import type { Request } from 'express';
import { z } from 'zod';
import { prisma } from '../../services/prisma.js';
import { audit } from '../../services/audit.js';
import { AppError } from '../../utils/app-error.js';
import { hashPassword, verifyPassword, PASSWORD_MAX_BYTES } from './password.js';
import { issueRefreshToken } from './tokens.js';

export const updateProfileSchema = z
  .object({ name: z.string().trim().min(2, 'Enter your full name').max(120) })
  .strict();

export const changePasswordSchema = z
  .object({
    currentPassword: z.string().min(1, 'Enter your current password').max(200),
    newPassword: z
      .string()
      .min(8, 'Password must be at least 8 characters')
      .refine((p) => Buffer.byteLength(p, 'utf8') <= PASSWORD_MAX_BYTES, 'Password is too long')
      .refine((p) => p.trim().length > 0, 'Password cannot be only spaces'),
  })
  .strict();

export async function updateProfile(userId: string, name: string, req: Request) {
  await prisma.$transaction(async (tx) => {
    const before = await tx.user.findUniqueOrThrow({
      where: { id: userId },
      select: { name: true },
    });
    if (before.name === name) return;
    await tx.user.update({ where: { id: userId }, data: { name } });
    await audit(
      tx,
      {
        actorUserId: userId,
        action: 'user.profile_updated',
        entityType: 'User',
        entityId: userId,
        metadata: { changed: ['name'] },
      },
      req,
    );
  });
}

/**
 * Changes the password after checking the current one. Every session is signed out; the caller
 * gets a fresh session so this device stays signed in.
 */
export async function changePassword(
  userId: string,
  input: z.infer<typeof changePasswordSchema>,
  req: Request,
) {
  const user = await prisma.user.findUniqueOrThrow({
    where: { id: userId },
    select: { passwordHash: true },
  });
  if (!(await verifyPassword(input.currentPassword, user.passwordHash))) {
    throw new AppError(400, 'WRONG_PASSWORD', 'Your current password is not correct.', {
      currentPassword: ['Current password is not correct'],
    });
  }
  if (input.currentPassword === input.newPassword) {
    throw new AppError(400, 'SAME_PASSWORD', 'Choose a password you are not using now.', {
      newPassword: ['Must be different from your current password'],
    });
  }
  const passwordHash = await hashPassword(input.newPassword);
  return prisma.$transaction(async (tx) => {
    await tx.user.update({ where: { id: userId }, data: { passwordHash } });
    await tx.refreshToken.updateMany({
      where: { userId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    await audit(
      tx,
      {
        actorUserId: userId,
        action: 'auth.password_changed',
        entityType: 'User',
        entityId: userId,
      },
      req,
    );
    return issueRefreshToken(tx, userId);
  });
}
