import type { MembershipRole } from '../generated/prisma/client.js';

declare global {
  namespace Express {
    interface Request {
      /** Set by requireAuth. */
      auth?: { userId: string; isPlatformAdmin: boolean };
      /** Set by requireTenantMember. */
      membership?: { id: string; tenantId: string; role: MembershipRole };
    }
  }
}

export {};
