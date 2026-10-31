import type { MembershipRole } from '../generated/prisma/client.js';

/**
 * Central role -> permission policy (project plan section 7.7).
 * Routes check permissions, never role names, so roles can change in one place.
 */
export const PERMISSIONS = [
  'tenant.read',
  'tenant.update',
  'members.read',
  'members.manage',
  'billing.manage',
  'customers.read',
  'customers.write',
  'vehicles.read',
  'vehicles.write',
  'jobs.read',
  'jobs.write',
  'invoices.read',
  'invoices.write',
  'payments.read',
  'payments.write',
  'reports.read',
] as const;

export type Permission = (typeof PERMISSIONS)[number];

const ALL = new Set<Permission>(PERMISSIONS);

const POLICY: Record<MembershipRole, ReadonlySet<Permission>> = {
  OWNER: ALL,
  ADMIN: new Set(PERMISSIONS.filter((p) => p !== 'billing.manage')),
  OPERATIONS: new Set<Permission>([
    'tenant.read',
    'members.read',
    'customers.read',
    'customers.write',
    'vehicles.read',
    'vehicles.write',
    'jobs.read',
    'jobs.write',
    'invoices.read',
    'reports.read',
  ]),
  ACCOUNTS: new Set<Permission>([
    'tenant.read',
    'members.read',
    'customers.read',
    'jobs.read',
    'vehicles.read',
    'invoices.read',
    'invoices.write',
    'payments.read',
    'payments.write',
    'reports.read',
  ]),
  VIEWER: new Set<Permission>([
    'tenant.read',
    'customers.read',
    'vehicles.read',
    'jobs.read',
    'invoices.read',
    'payments.read',
    'reports.read',
  ]),
};

export function can(role: MembershipRole, permission: Permission): boolean {
  return POLICY[role].has(permission);
}

export function permissionsFor(role: MembershipRole): Permission[] {
  return PERMISSIONS.filter((p) => POLICY[role].has(p));
}
