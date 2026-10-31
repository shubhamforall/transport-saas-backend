import { SignJWT, jwtVerify } from 'jose';
import { env } from '../../config/env.js';
import type { Prisma } from '../../generated/prisma/client.js';
import { prisma } from '../../services/prisma.js';
import { randomToken, sha256 } from '../../utils/crypto.js';
import { createId } from './id.js';

const secret = new TextEncoder().encode(env.JWT_ACCESS_SECRET);
const ISSUER = 'vaharo-api';
const AUDIENCE = 'vaharo-web';

export async function signAccessToken(userId: string): Promise<string> {
  return new SignJWT({})
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(userId)
    .setIssuer(ISSUER)
    .setAudience(AUDIENCE)
    .setIssuedAt()
    .setExpirationTime(env.JWT_ACCESS_TTL)
    .sign(secret);
}

/** Returns the user id, or null if the token is missing, invalid or expired. */
export async function verifyAccessToken(token: string | undefined): Promise<string | null> {
  if (!token) return null;
  try {
    const { payload } = await jwtVerify(token, secret, {
      issuer: ISSUER,
      audience: AUDIENCE,
      algorithms: ['HS256'],
    });
    return typeof payload.sub === 'string' ? payload.sub : null;
  } catch {
    return null;
  }
}

type Tx = Pick<Prisma.TransactionClient, 'refreshToken'>;

/** Creates a refresh token. Only its hash is stored; the raw value goes to the cookie. */
export async function issueRefreshToken(
  db: Tx,
  userId: string,
  familyId: string = createId(),
): Promise<string> {
  const token = randomToken();
  await db.refreshToken.create({
    data: {
      userId,
      familyId,
      tokenHash: sha256(token),
      expiresAt: new Date(Date.now() + env.REFRESH_TOKEN_TTL_DAYS * 86_400_000),
    },
  });
  return token;
}

/**
 * Several tabs may refresh at the same moment with the same token. A token revoked this
 * recently is treated as a lost race, not as theft.
 */
const REUSE_GRACE_MS = 30_000;

export type RotateResult = { ok: true; userId: string; token: string } | { ok: false };

/**
 * Rotates a refresh token: the old one is revoked and a new one in the same family is issued.
 * Reusing an already-rotated token (outside the grace window) revokes the whole family.
 */
export async function rotateRefreshToken(rawToken: string | undefined): Promise<RotateResult> {
  if (!rawToken || rawToken.length > 200) return { ok: false };
  const existing = await prisma.refreshToken.findUnique({ where: { tokenHash: sha256(rawToken) } });
  if (!existing) return { ok: false };

  const now = new Date();
  if (existing.revokedAt) {
    if (now.getTime() - existing.revokedAt.getTime() > REUSE_GRACE_MS) {
      await prisma.refreshToken.updateMany({
        where: { familyId: existing.familyId, revokedAt: null },
        data: { revokedAt: now },
      });
    }
    return { ok: false };
  }
  if (existing.expiresAt <= now) return { ok: false };

  return prisma.$transaction(async (tx) => {
    // Conditional update: only one concurrent request can win the rotation.
    const { count } = await tx.refreshToken.updateMany({
      where: { id: existing.id, revokedAt: null },
      data: { revokedAt: now },
    });
    if (count !== 1) return { ok: false } as const;
    const user = await tx.user.findUnique({
      where: { id: existing.userId },
      select: { status: true },
    });
    if (user?.status !== 'ACTIVE') return { ok: false } as const;
    const token = await issueRefreshToken(tx, existing.userId, existing.familyId);
    return { ok: true, userId: existing.userId, token } as const;
  });
}

export async function revokeRefreshToken(rawToken: string | undefined): Promise<void> {
  if (!rawToken || rawToken.length > 200) return;
  await prisma.refreshToken.updateMany({
    where: { tokenHash: sha256(rawToken), revokedAt: null },
    data: { revokedAt: new Date() },
  });
}
