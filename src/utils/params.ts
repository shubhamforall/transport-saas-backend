import type { Request } from 'express';
import { idSchema } from './fields.js';
import { AppError } from './app-error.js';

/** Reads an id path parameter; malformed ids look the same as unknown ones (404). */
export function idParam(req: Request, name: string, what = 'Record'): string {
  const parsed = idSchema.safeParse(req.params[name]);
  if (!parsed.success) throw AppError.notFound(`${what} not found`);
  return parsed.data;
}

/** Tenant id verified by requireTenantMember. Never read tenantId from the URL directly. */
export function tenantOf(req: Request): string {
  if (!req.membership) throw AppError.notFound('Company not found');
  return req.membership.tenantId;
}

export function userOf(req: Request): string {
  if (!req.auth) throw AppError.unauthorized();
  return req.auth.userId;
}
