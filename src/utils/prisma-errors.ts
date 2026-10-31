import { Prisma } from '../generated/prisma/client.js';

/** True for a unique-constraint violation (duplicate key). */
export function isUniqueViolation(err: unknown): boolean {
  return err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002';
}
