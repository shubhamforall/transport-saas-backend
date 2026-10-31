import { Router, type Request } from 'express';
import { rateLimit } from 'express-rate-limit';
import { requireAuth } from '../../middleware/auth.js';
import { requirePermission } from '../../middleware/tenant.js';
import { can } from '../../services/permissions.js';
import { AppError } from '../../utils/app-error.js';
import { idParam, userOf } from '../../utils/params.js';
import {
  acceptInvitation,
  changeRole,
  changeRoleSchema,
  invite,
  inviteSchema,
  listMembers,
  lookupInvitation,
  removeMember,
  revokeInvitation,
  tokenSchema,
  transferOwnership,
  transferSchema,
} from './team.service.js';

function actorOf(req: Request) {
  const m = req.membership;
  if (!m) throw AppError.notFound('Company not found');
  return { userId: userOf(req), tenantId: m.tenantId, role: m.role, membershipId: m.id };
}

/** Mounted under /tenants/:tenantId after requireTenantMember. */
export const teamRouter = Router({ mergeParams: true });

teamRouter.get('/members', requirePermission('members.read'), async (req, res) => {
  const m = req.membership!;
  res.json(await listMembers(m.tenantId, can(m.role, 'members.manage')));
});

teamRouter.post('/invitations', requirePermission('members.manage'), async (req, res) => {
  const input = inviteSchema.parse(req.body);
  res.status(201).json(await invite(actorOf(req), input, req));
});

teamRouter.post(
  '/invitations/:invitationId/revoke',
  requirePermission('members.manage'),
  async (req, res) => {
    await revokeInvitation(actorOf(req), idParam(req, 'invitationId', 'Invitation'), req);
    res.status(204).end();
  },
);

teamRouter.patch(
  '/members/:membershipId/role',
  requirePermission('members.manage'),
  async (req, res) => {
    const { role } = changeRoleSchema.parse(req.body);
    await changeRole(actorOf(req), idParam(req, 'membershipId', 'Member'), role, req);
    res.status(204).end();
  },
);

teamRouter.delete(
  '/members/:membershipId',
  requirePermission('members.manage'),
  async (req, res) => {
    await removeMember(actorOf(req), idParam(req, 'membershipId', 'Member'), req);
    res.status(204).end();
  },
);

teamRouter.post('/transfer-ownership', requirePermission('members.manage'), async (req, res) => {
  const input = transferSchema.parse(req.body);
  await transferOwnership(actorOf(req), input, req);
  res.status(204).end();
});

const inviteLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 30,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  handler: (_req, _res, next) =>
    next(new AppError(429, 'TOO_MANY_REQUESTS', 'Too many attempts. Please wait and try again.')),
});

/** Mounted at /api/v1/invitations (not tenant-scoped). */
export const invitationsRouter = Router();

invitationsRouter.get('/lookup', inviteLimiter, async (req, res) => {
  const { token } = tokenSchema.parse(req.query);
  res.json(await lookupInvitation(token));
});

invitationsRouter.post('/accept', inviteLimiter, requireAuth, async (req, res) => {
  const { token } = tokenSchema.parse(req.body);
  res.json(await acceptInvitation(userOf(req), token, req));
});
