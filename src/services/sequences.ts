import type { Prisma } from '../generated/prisma/client.js';
import { prisma } from './prisma.js';

/**
 * Makes sure a counter row exists. INSERT IGNORE semantics make this safe under concurrency.
 * Call before the transaction that uses nextSequenceValue.
 */
export async function ensureSequence(tenantId: string, name: string) {
  await prisma.tenantSequence.createMany({
    data: [{ tenantId, name, nextNumber: 1 }],
    skipDuplicates: true,
  });
}

/**
 * Returns the next number of a per-company counter. The UPDATE locks the row until the
 * surrounding transaction ends, so concurrent requests get distinct numbers.
 */
export async function nextSequenceValue(
  tx: Prisma.TransactionClient,
  tenantId: string,
  name: string,
): Promise<number> {
  const row = await tx.tenantSequence.update({
    where: { tenantId_name: { tenantId, name } },
    data: { nextNumber: { increment: 1 } },
    select: { nextNumber: true },
  });
  return row.nextNumber - 1;
}
