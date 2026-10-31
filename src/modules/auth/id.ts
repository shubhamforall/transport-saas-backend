import { randomBytes } from 'node:crypto';

/** Short random id for grouping records (e.g. refresh-token families). Not a database primary key. */
export function createId(): string {
  return randomBytes(15).toString('hex').slice(0, 30);
}
