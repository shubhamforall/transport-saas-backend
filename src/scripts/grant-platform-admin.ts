/**
 * Makes an existing user a platform (Super Admin) administrator, or removes the right.
 *
 *   npm run platform:admin -- someone@example.com
 *   npm run platform:admin -- someone@example.com --revoke
 *
 * Run on the server with production env vars; there is deliberately no API for this.
 */
import { prisma } from '../services/prisma.js';

const [email, flag] = process.argv.slice(2);
if (!email) {
  console.error('Usage: npm run platform:admin -- <email> [--revoke]');
  process.exit(1);
}

const revoke = flag === '--revoke';
const user = await prisma.user.findUnique({ where: { email: email.trim().toLowerCase() } });
if (!user) {
  console.error(`No user with email ${email}. They must sign up first.`);
  process.exitCode = 1;
} else {
  await prisma.user.update({ where: { id: user.id }, data: { isPlatformAdmin: !revoke } });
  await prisma.auditLog.create({
    data: {
      action: revoke ? 'platform.admin_revoked' : 'platform.admin_granted',
      entityType: 'User',
      entityId: user.id,
      metadataJson: { via: 'cli' },
    },
  });
  console.log(`${email} is ${revoke ? 'no longer' : 'now'} a platform administrator.`);
}
await prisma.$disconnect();
