import type { Request } from 'express';
import { z } from 'zod';
import { env } from '../../config/env.js';
import { prisma } from '../../services/prisma.js';
import { audit } from '../../services/audit.js';
import { sendMail, simpleHtml } from '../../services/mailer.js';
import { AppError } from '../../utils/app-error.js';
import { randomToken, sha256 } from '../../utils/crypto.js';
import { logger } from '../../utils/logger.js';
import { emailSchema } from './auth.schemas.js';
import { hashPassword, PASSWORD_MAX_BYTES } from './password.js';

const RESET_TTL_MS = 60 * 60 * 1000;

export const forgotPasswordSchema = z.object({ email: emailSchema }).strict();

export const resetPasswordSchema = z
  .object({
    token: z.string().min(20).max(200),
    password: z
      .string()
      .min(8, 'Password must be at least 8 characters')
      .refine((p) => Buffer.byteLength(p, 'utf8') <= PASSWORD_MAX_BYTES, 'Password is too long'),
  })
  .strict();

/**
 * Always succeeds from the caller's point of view, so it never reveals whether an email has an
 * account. When it does, a single-use link valid for one hour is emailed.
 */
export async function requestPasswordReset(email: string, req: Request) {
  const user = await prisma.user.findUnique({
    where: { email },
    select: { id: true, name: true, status: true },
  });
  if (!user || user.status !== 'ACTIVE') return;

  const token = randomToken();
  await prisma.$transaction(async (tx) => {
    // Only the newest link works.
    await tx.passwordResetToken.updateMany({
      where: { userId: user.id, usedAt: null },
      data: { usedAt: new Date() },
    });
    await tx.passwordResetToken.create({
      data: {
        userId: user.id,
        tokenHash: sha256(token),
        expiresAt: new Date(Date.now() + RESET_TTL_MS),
      },
    });
    await audit(
      tx,
      {
        actorUserId: user.id,
        action: 'auth.password_reset_requested',
        entityType: 'User',
        entityId: user.id,
      },
      req,
    );
  });

  const link = `${env.APP_BASE_URL.replace(/\/$/, '')}/reset-password?token=${encodeURIComponent(token)}`;
  const paragraphs = [
    `Hello ${user.name},`,
    'We received a request to reset your Vaharo password. The link below works once and expires in 1 hour.',
    "If you didn't ask for this, you can ignore this email. Your password won't change.",
  ];
  try {
    await sendMail({
      to: email,
      subject: 'Reset your Vaharo password',
      text: `${paragraphs.join('\n\n')}\n\n${link}`,
      html: simpleHtml(paragraphs, { label: 'Reset password', url: link }),
    });
    await prisma.emailLog.create({
      data: {
        kind: 'password_reset',
        recipient: email,
        subject: 'Reset your Vaharo password',
        status: 'SENT',
        attemptCount: 1,
        sentAt: new Date(),
      },
    });
  } catch {
    // Do not reveal failures to the caller (that would leak which emails exist).
    logger.warn({ userId: user.id }, 'Password reset email failed');
    await prisma.emailLog.create({
      data: {
        kind: 'password_reset',
        recipient: email,
        subject: 'Reset your Vaharo password',
        status: 'FAILED',
        attemptCount: 1,
        lastErrorSafe: 'Delivery failed',
      },
    });
  }
}

/** Sets a new password and signs out every existing session. */
export async function resetPassword(token: string, password: string, req: Request) {
  const record = await prisma.passwordResetToken.findUnique({
    where: { tokenHash: sha256(token) },
  });
  const invalid = () =>
    new AppError(
      400,
      'RESET_LINK_INVALID',
      'This reset link is invalid or has expired. Request a new one.',
    );
  if (!record || record.usedAt || record.expiresAt <= new Date()) throw invalid();

  const passwordHash = await hashPassword(password);
  await prisma.$transaction(async (tx) => {
    // Conditional: two concurrent uses of the same link cannot both succeed.
    const { count } = await tx.passwordResetToken.updateMany({
      where: { id: record.id, usedAt: null },
      data: { usedAt: new Date() },
    });
    if (count !== 1) throw invalid();
    await tx.user.update({ where: { id: record.userId }, data: { passwordHash } });
    // The link was opened from the inbox, which proves the email address.
    await tx.user.updateMany({
      where: { id: record.userId, emailVerifiedAt: null },
      data: { emailVerifiedAt: new Date() },
    });
    await tx.refreshToken.updateMany({
      where: { userId: record.userId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    await audit(
      tx,
      {
        actorUserId: record.userId,
        action: 'auth.password_reset',
        entityType: 'User',
        entityId: record.userId,
      },
      req,
    );
  });
}
