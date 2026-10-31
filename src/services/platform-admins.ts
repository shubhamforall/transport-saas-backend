import type { Request } from 'express';
import { PLATFORM_ADMIN_EMAILS } from '../config/platform-admins.js';
import { logger } from '../utils/logger.js';
import { prisma } from './prisma.js';
import { audit } from './audit.js';

const LISTED = new Set(PLATFORM_ADMIN_EMAILS.map((e) => e.trim().toLowerCase()));

/** Promotes one user if listed, verified, active and not yet an admin. Safe to call often. */
export async function promoteIfListed(userId: string, req?: Pick<Request, 'ip'>) {
  if (LISTED.size === 0) return false;
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { email: true, emailVerifiedAt: true, isPlatformAdmin: true, status: true },
  });
  if (
    !user ||
    user.isPlatformAdmin ||
    !user.emailVerifiedAt ||
    user.status !== 'ACTIVE' ||
    !LISTED.has(user.email)
  ) {
    return false;
  }
  await prisma.$transaction(async (tx) => {
    // Conditional, so concurrent calls write one audit entry at most.
    const { count } = await tx.user.updateMany({
      where: { id: userId, isPlatformAdmin: false },
      data: { isPlatformAdmin: true },
    });
    if (count !== 1) return;
    await audit(
      tx,
      {
        actorUserId: userId,
        action: 'platform.admin_granted_by_config',
        entityType: 'User',
        entityId: userId,
      },
      req,
    );
  });
  logger.info({ userId }, 'Granted Super Admin from the built-in admin list');
  return true;
}

/** Promotes listed users who already exist and are verified. Runs at server start. */
export async function syncPlatformAdmins() {
  if (LISTED.size === 0) return 0;
  const users = await prisma.user.findMany({
    where: {
      email: { in: [...LISTED] },
      isPlatformAdmin: false,
      emailVerifiedAt: { not: null },
      status: 'ACTIVE',
    },
    select: { id: true },
  });
  let promoted = 0;
  for (const u of users) if (await promoteIfListed(u.id)) promoted += 1;
  return promoted;
}
