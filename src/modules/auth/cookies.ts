import type { CookieOptions, Response } from 'express';
import { env, isProduction, durationToSeconds } from '../../config/env.js';

export const ACCESS_COOKIE = 'vaharo_at';
export const REFRESH_COOKIE = 'vaharo_rt';
export const CSRF_COOKIE = 'vaharo_csrf';

/** Refresh cookie is only sent to auth endpoints, never to the rest of the API. */
const REFRESH_PATH = '/api/v1/auth';

function base(): CookieOptions {
  return {
    httpOnly: true,
    secure: isProduction,
    sameSite: 'lax',
    ...(env.COOKIE_DOMAIN ? { domain: env.COOKIE_DOMAIN } : {}),
  };
}

export function setAuthCookies(res: Response, accessToken: string, refreshToken: string) {
  res.cookie(ACCESS_COOKIE, accessToken, {
    ...base(),
    path: '/',
    maxAge: durationToSeconds(env.JWT_ACCESS_TTL) * 1000,
  });
  res.cookie(REFRESH_COOKIE, refreshToken, {
    ...base(),
    path: REFRESH_PATH,
    maxAge: env.REFRESH_TOKEN_TTL_DAYS * 24 * 60 * 60 * 1000,
  });
}

export function clearAuthCookies(res: Response) {
  res.clearCookie(ACCESS_COOKIE, { ...base(), path: '/' });
  res.clearCookie(REFRESH_COOKIE, { ...base(), path: REFRESH_PATH });
}

export function setCsrfCookie(res: Response, token: string) {
  // HttpOnly: the browser app receives the value from GET /auth/csrf, not from document.cookie,
  // so this also works when the frontend and API are on different subdomains.
  res.cookie(CSRF_COOKIE, token, { ...base(), path: '/' });
}
