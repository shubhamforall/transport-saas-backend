import type { Request } from 'express';
import type { Prisma } from '../generated/prisma/client.js';
import { env } from '../config/env.js';
import { sha256 } from '../utils/crypto.js';

type Tx = Pick<Prisma.TransactionClient, 'auditLog'>;

export interface AuditEntry {
  tenantId?: string | null;
  actorUserId?: string | null;
  action: string;
  entityType: string;
  entityId: string;
  /** Never include passwords, tokens or unnecessary personal data. */
  metadata?: Prisma.InputJsonValue;
}

/** Hashes the client IP with a server secret so logs can correlate without storing raw IPs. */
export function ipHash(req: Pick<Request, 'ip'>): string | null {
  return req.ip ? sha256(`${env.JWT_ACCESS_SECRET}:${req.ip}`) : null;
}

/** Writes an audit record. Pass the transaction client to keep it atomic with the change. */
export async function audit(db: Tx, entry: AuditEntry, req?: Pick<Request, 'ip'>) {
  await db.auditLog.create({
    data: {
      tenantId: entry.tenantId ?? null,
      actorUserId: entry.actorUserId ?? null,
      action: entry.action,
      entityType: entry.entityType,
      entityId: entry.entityId,
      metadataJson: entry.metadata,
      ipHash: req ? ipHash(req) : null,
    },
  });
}
