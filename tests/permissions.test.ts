import { describe, expect, it } from 'vitest';
import { PERMISSIONS, can, permissionsFor } from '../src/services/permissions.js';

describe('role permission policy', () => {
  it('owner has every permission', () => {
    expect(permissionsFor('OWNER')).toEqual([...PERMISSIONS]);
  });

  it('only the owner manages billing', () => {
    expect(can('OWNER', 'billing.manage')).toBe(true);
    for (const role of ['ADMIN', 'OPERATIONS', 'ACCOUNTS', 'VIEWER'] as const) {
      expect(can(role, 'billing.manage')).toBe(false);
    }
  });

  it('viewer cannot write anything', () => {
    expect(
      permissionsFor('VIEWER').some(
        (p) => p.endsWith('.write') || p.endsWith('.manage') || p === 'tenant.update',
      ),
    ).toBe(false);
  });

  it('operations cannot manage team, billing or invoices', () => {
    expect(can('OPERATIONS', 'members.manage')).toBe(false);
    expect(can('OPERATIONS', 'billing.manage')).toBe(false);
    expect(can('OPERATIONS', 'invoices.write')).toBe(false);
    expect(can('OPERATIONS', 'jobs.write')).toBe(true);
  });

  it('accounts manage invoices and payments but not vehicles or team', () => {
    expect(can('ACCOUNTS', 'invoices.write')).toBe(true);
    expect(can('ACCOUNTS', 'payments.write')).toBe(true);
    expect(can('ACCOUNTS', 'vehicles.write')).toBe(false);
    expect(can('ACCOUNTS', 'members.manage')).toBe(false);
  });
});
