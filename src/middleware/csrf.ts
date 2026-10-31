import type { RequestHandler } from 'express';
import { AppError } from '../utils/app-error.js';
import { safeEqual } from '../utils/crypto.js';
import { CSRF_COOKIE } from '../modules/auth/cookies.js';

export const CSRF_HEADER = 'x-csrf-token';
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * Double-submit CSRF check for state-changing requests: the X-CSRF-Token header must match
 * the HttpOnly csrf cookie. The browser app gets the token from GET /api/v1/auth/csrf.
 */
export const csrfProtection: RequestHandler = (req, _res, next) => {
  if (SAFE_METHODS.has(req.method)) return next();
  const cookie: unknown = req.cookies?.[CSRF_COOKIE];
  const header = req.header(CSRF_HEADER);
  if (typeof cookie !== 'string' || !header || !safeEqual(cookie, header)) {
    return next(new AppError(403, 'CSRF_INVALID', 'Your session expired. Please try again.'));
  }
  next();
};
