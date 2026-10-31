import { Router } from 'express';
import { rateLimit } from 'express-rate-limit';
import { requireAuth } from '../../middleware/auth.js';
import { AppError } from '../../utils/app-error.js';
import { randomToken } from '../../utils/crypto.js';
import { loginSchema, registerSchema } from './auth.schemas.js';
import { createSession, getMe, login, register } from './auth.service.js';
import { REFRESH_COOKIE, clearAuthCookies, setAuthCookies, setCsrfCookie } from './cookies.js';
import { revokeRefreshToken, rotateRefreshToken } from './tokens.js';
import { promoteIfListed } from '../../services/platform-admins.js';
import {
  forgotPasswordSchema,
  requestPasswordReset,
  resetPassword,
  resetPasswordSchema,
} from './password-reset.js';
import {
  changePassword,
  changePasswordSchema,
  updateProfile,
  updateProfileSchema,
} from './account.js';
import {
  resendVerification,
  resendVerificationSchema,
  verifyEmail,
  verifyEmailSchema,
} from './email-verification.js';

export interface AuthRouterOptions {
  rateLimitMax: number;
}

export function createAuthRouter({ rateLimitMax }: AuthRouterOptions) {
  const router = Router();

  const authLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: rateLimitMax,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    handler: (_req, _res, next) =>
      next(
        new AppError(
          429,
          'TOO_MANY_REQUESTS',
          'Too many attempts. Please wait a few minutes and try again.',
        ),
      ),
  });

  /** Issues a CSRF token (cookie + body). The app sends it back in the X-CSRF-Token header. */
  router.get('/csrf', (_req, res) => {
    const token = randomToken();
    setCsrfCookie(res, token);
    res.json({ csrfToken: token });
  });

  router.post('/register', authLimiter, async (req, res) => {
    const input = registerSchema.parse(req.body);
    const result = await register(input, req);
    if (!result.verified) {
      // No session yet: the account is usable once the emailed code is confirmed.
      res.status(202).json({
        verificationRequired: true,
        email: input.email,
        emailSent: result.emailSent,
      });
      return;
    }
    await promoteIfListed(result.userId, req);
    const session = await createSession(result.userId, result.refreshToken);
    setAuthCookies(res, session.accessToken, session.refreshToken);
    res.status(201).json(await getMe(result.userId));
  });

  router.post('/verify-email', authLimiter, async (req, res) => {
    const { email, code } = verifyEmailSchema.parse(req.body);
    const { userId, refreshToken } = await verifyEmail(email, code, req);
    await promoteIfListed(userId, req);
    const session = await createSession(userId, refreshToken);
    setAuthCookies(res, session.accessToken, session.refreshToken);
    res.json(await getMe(userId));
  });

  router.post('/resend-verification', authLimiter, async (req, res) => {
    const { email } = resendVerificationSchema.parse(req.body);
    await resendVerification(email, req);
    res
      .status(202)
      .json({ message: 'If this email is waiting for verification, a new code is on its way.' });
  });

  router.post('/login', authLimiter, async (req, res) => {
    const input = loginSchema.parse(req.body);
    const { userId, refreshToken } = await login(input, req);
    await promoteIfListed(userId, req);
    const session = await createSession(userId, refreshToken);
    setAuthCookies(res, session.accessToken, session.refreshToken);
    res.json(await getMe(userId));
  });

  router.post('/refresh', authLimiter, async (req, res) => {
    const result = await rotateRefreshToken(req.cookies?.[REFRESH_COOKIE] as string | undefined);
    if (!result.ok) {
      clearAuthCookies(res);
      throw new AppError(401, 'SESSION_EXPIRED', 'Your session has expired. Please sign in again.');
    }
    const session = await createSession(result.userId, result.token);
    setAuthCookies(res, session.accessToken, session.refreshToken);
    res.status(204).end();
  });

  // Logout works even with an expired access token, so it does not use requireAuth.
  router.post('/logout', async (req, res) => {
    await revokeRefreshToken(req.cookies?.[REFRESH_COOKIE] as string | undefined);
    clearAuthCookies(res);
    res.status(204).end();
  });

  router.post('/forgot-password', authLimiter, async (req, res) => {
    const { email } = forgotPasswordSchema.parse(req.body);
    await requestPasswordReset(email, req);
    // Same answer whether or not the email has an account.
    res.status(202).json({
      message: 'If an account exists for that email, we have sent a reset link.',
    });
  });

  router.post('/reset-password', authLimiter, async (req, res) => {
    const { token, password } = resetPasswordSchema.parse(req.body);
    await resetPassword(token, password, req);
    clearAuthCookies(res);
    res.status(204).end();
  });

  router.get('/me', requireAuth, async (req, res) => {
    res.json(await getMe(req.auth!.userId));
  });

  router.patch('/me', requireAuth, async (req, res) => {
    const { name } = updateProfileSchema.parse(req.body);
    await updateProfile(req.auth!.userId, name, req);
    res.json(await getMe(req.auth!.userId));
  });

  router.post('/change-password', requireAuth, authLimiter, async (req, res) => {
    const input = changePasswordSchema.parse(req.body);
    const userId = req.auth!.userId;
    const refreshToken = await changePassword(userId, input, req);
    // Other devices are signed out; this one gets a fresh session.
    const session = await createSession(userId, refreshToken);
    setAuthCookies(res, session.accessToken, session.refreshToken);
    res.status(204).end();
  });

  return router;
}
