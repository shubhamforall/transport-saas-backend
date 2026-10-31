import { createHmac, randomInt } from 'node:crypto';
import type { Request } from 'express';
import { z } from 'zod';
import { env } from '../../config/env.js';
import { prisma } from '../../services/prisma.js';
import { audit } from '../../services/audit.js';
import { sendMail, simpleHtml } from '../../services/mailer.js';
import { AppError } from '../../utils/app-error.js';
import { safeEqual } from '../../utils/crypto.js';
import { logger } from '../../utils/logger.js';
import { emailSchema } from './auth.schemas.js';
import { issueRefreshToken } from './tokens.js';

export const CODE_TTL_MINUTES = 10;
export const MAX_ATTEMPTS = 5;
export const RESEND_COOLDOWN_SECONDS = 60;
export const MAX_CODES_PER_HOUR = 5;

export const verifyEmailSchema = z
  .object({
    email: emailSchema,
    code: z
      .string()
      .transform((s) => s.replace(/\s/g, ''))
      .pipe(z.string().regex(/^\d{6}$/, 'Enter the 6-digit code from the email')),
  })
  .strict();

export const resendVerificationSchema = z.object({ email: emailSchema }).strict();

/**
 * Keyed hash: a 6-digit code has too few combinations for a plain hash, so a leaked table must
 * not be enough to recover codes. Bound to the user so a code is useless for other accounts.
 */
function hashCode(userId: string, code: string) {
  return createHmac('sha256', env.JWT_ACCESS_SECRET)
    .update(`verify:${userId}:${code}`)
    .digest('hex');
}

function newCode() {
  return randomInt(0, 1_000_000).toString().padStart(6, '0');
}

type LimitMode = 'skip' | 'throw';
/** `skipped`: a limit applied and the caller chose not to throw. */
export type SendStatus = 'sent' | 'skipped' | 'failed';

interface SendOptions {
  /** A code was sent less than a minute ago. */
  onCooldown: LimitMode;
  /** Too many codes sent in the last hour. */
  onHourlyLimit: LimitMode;
}

/**
 * Creates a new code (the previous one stops working) and emails it.
 * Returns whether an email went out; limits either skip silently or throw 429.
 */
export async function sendVerificationCode(
  user: { id: string; name: string; email: string },
  req: Request,
  options: SendOptions,
): Promise<SendStatus> {
  const now = Date.now();
  const recent = await prisma.emailVerificationCode.findMany({
    where: { userId: user.id, createdAt: { gt: new Date(now - 60 * 60 * 1000) } },
    orderBy: { createdAt: 'desc' },
    select: { createdAt: true },
  });
  const last = recent[0];
  if (last && now - last.createdAt.getTime() < RESEND_COOLDOWN_SECONDS * 1000) {
    if (options.onCooldown === 'skip') return 'skipped';
    const wait = Math.ceil(
      (RESEND_COOLDOWN_SECONDS * 1000 - (now - last.createdAt.getTime())) / 1000,
    );
    throw new AppError(
      429,
      'RESEND_TOO_SOON',
      `Please wait ${wait} seconds before asking for another code.`,
    );
  }
  if (recent.length >= MAX_CODES_PER_HOUR) {
    if (options.onHourlyLimit === 'skip') return 'skipped';
    throw new AppError(
      429,
      'TOO_MANY_CODES',
      'Too many codes were requested for this email. Please try again in an hour.',
    );
  }

  const code = newCode();
  await prisma.$transaction(async (tx) => {
    // Only the newest code works.
    await tx.emailVerificationCode.updateMany({
      where: { userId: user.id, usedAt: null },
      data: { usedAt: new Date() },
    });
    await tx.emailVerificationCode.create({
      data: {
        userId: user.id,
        codeHash: hashCode(user.id, code),
        expiresAt: new Date(now + CODE_TTL_MINUTES * 60 * 1000),
      },
    });
    await audit(
      tx,
      {
        actorUserId: user.id,
        action: 'auth.verification_code_sent',
        entityType: 'User',
        entityId: user.id,
      },
      req,
    );
  });

  const subject = `${code} is your Vaharo verification code`;
  const paragraphs = [
    `Hello ${user.name},`,
    `Your Vaharo verification code is:`,
    code,
    `Enter it on the sign-up screen to finish creating your account. It expires in ${CODE_TTL_MINUTES} minutes.`,
    "If you didn't try to create a Vaharo account, you can ignore this email.",
  ];
  const html = simpleHtml(paragraphs).replace(
    `<p style="margin:0 0 14px">${code}</p>`,
    `<p style="margin:6px 0 18px;font-size:28px;font-weight:700;letter-spacing:6px">${code}</p>`,
  );
  try {
    await sendMail({ to: user.email, subject, text: paragraphs.join('\n\n'), html });
    await prisma.emailLog.create({
      data: {
        kind: 'email_verification',
        recipient: user.email,
        // The subject holds the code; keep it out of the log.
        subject: 'Vaharo verification code',
        status: 'SENT',
        attemptCount: 1,
        sentAt: new Date(),
      },
    });
    return 'sent';
  } catch {
    logger.warn({ userId: user.id }, 'Verification email failed');
    await prisma.emailLog.create({
      data: {
        kind: 'email_verification',
        recipient: user.email,
        subject: 'Vaharo verification code',
        status: 'FAILED',
        attemptCount: 1,
        lastErrorSafe: 'Delivery failed',
      },
    });
    return 'failed';
  }
}

/** Checks the code; on success marks the email verified and starts a session. */
export async function verifyEmail(email: string, code: string, req: Request) {
  const user = await prisma.user.findUnique({
    where: { email },
    select: { id: true, emailVerifiedAt: true, status: true },
  });
  const expired = () =>
    new AppError(
      400,
      'CODE_EXPIRED',
      'This code has expired or is no longer valid. Request a new code.',
      { code: ['Request a new code'] },
    );
  if (!user || user.status !== 'ACTIVE') throw expired();
  if (user.emailVerifiedAt) {
    throw new AppError(409, 'ALREADY_VERIFIED', 'This email is already verified. Please sign in.');
  }

  const record = await prisma.emailVerificationCode.findFirst({
    where: { userId: user.id, usedAt: null },
    orderBy: { createdAt: 'desc' },
  });
  if (!record || record.expiresAt <= new Date()) throw expired();

  // Count the attempt before comparing, so parallel guesses cannot exceed the limit.
  const { count } = await prisma.emailVerificationCode.updateMany({
    where: { id: record.id, usedAt: null, attempts: { lt: MAX_ATTEMPTS } },
    data: { attempts: { increment: 1 } },
  });
  const locked = () =>
    new AppError(400, 'CODE_LOCKED', 'Too many wrong attempts. Request a new code.', {
      code: ['Too many wrong attempts'],
    });
  if (count !== 1) throw locked();

  if (!safeEqual(hashCode(user.id, code), record.codeHash)) {
    const left = MAX_ATTEMPTS - (record.attempts + 1);
    if (left <= 0) throw locked();
    throw new AppError(400, 'CODE_INVALID', 'That code is not correct.', {
      code: [`Incorrect code. ${left} ${left === 1 ? 'attempt' : 'attempts'} left.`],
    });
  }

  return prisma.$transaction(async (tx) => {
    const used = await tx.emailVerificationCode.updateMany({
      where: { id: record.id, usedAt: null },
      data: { usedAt: new Date() },
    });
    if (used.count !== 1) throw expired();
    await tx.user.update({ where: { id: user.id }, data: { emailVerifiedAt: new Date() } });
    await audit(
      tx,
      {
        actorUserId: user.id,
        action: 'user.email_verified',
        entityType: 'User',
        entityId: user.id,
      },
      req,
    );
    const refreshToken = await issueRefreshToken(tx, user.id);
    return { userId: user.id, refreshToken };
  });
}

/** Sends a fresh code. Says nothing about whether the email has an account. */
export async function resendVerification(email: string, req: Request) {
  const user = await prisma.user.findUnique({
    where: { email },
    select: { id: true, name: true, email: true, emailVerifiedAt: true, status: true },
  });
  if (!user || user.emailVerifiedAt || user.status !== 'ACTIVE') return;
  const status = await sendVerificationCode(user, req, {
    onCooldown: 'throw',
    onHourlyLimit: 'throw',
  });
  if (status === 'failed') {
    throw new AppError(
      503,
      'EMAIL_FAILED',
      "We couldn't send the email right now. Please try again in a minute.",
    );
  }
}
