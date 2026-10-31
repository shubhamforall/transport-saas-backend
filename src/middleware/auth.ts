import type { RequestHandler } from 'express';
import { prisma } from '../services/prisma.js';
import { AppError } from '../utils/app-error.js';
import { ACCESS_COOKIE } from '../modules/auth/cookies.js';
import { verifyAccessToken } from '../modules/auth/tokens.js';

/** Requires a valid access-token cookie for an active user. Sets req.auth. */
export const requireAuth: RequestHandler = async (req, _res, next) => {
  const userId = await verifyAccessToken(req.cookies?.[ACCESS_COOKIE] as string | undefined);
  if (!userId) return next(AppError.unauthorized());

  // Checked on every request so disabled users lose access immediately, not at token expiry.
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { id: true, status: true, isPlatformAdmin: true },
  });
  if (user?.status !== 'ACTIVE') return next(AppError.unauthorized());

  req.auth = { userId: user.id, isPlatformAdmin: user.isPlatformAdmin };
  next();
};
