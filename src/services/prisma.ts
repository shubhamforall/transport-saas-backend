import { PrismaMariaDb } from '@prisma/adapter-mariadb';
import { PrismaClient } from '../generated/prisma/client.js';
import { env } from '../config/env.js';

/** Builds a mariadb-driver connection string, which also works with MySQL 8. */
function toDriverUrl(url: string): string {
  const u = new URL(url.replace(/^mysql:/, 'mariadb:'));
  // MySQL 8 uses caching_sha2_password; allow key retrieval for local non-TLS connections.
  if (!u.searchParams.has('allowPublicKeyRetrieval'))
    u.searchParams.set('allowPublicKeyRetrieval', 'true');
  return u.toString();
}

const adapter = new PrismaMariaDb(toDriverUrl(env.DATABASE_URL));

export const prisma = new PrismaClient({ adapter });

export type Db = typeof prisma;
