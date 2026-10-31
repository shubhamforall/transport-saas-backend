import bcrypt from 'bcryptjs';
import { env } from '../../config/env.js';

/** bcrypt only uses the first 72 bytes, so longer passwords are rejected at validation. */
export const PASSWORD_MAX_BYTES = 72;

export function hashPassword(password: string): Promise<string> {
  return bcrypt.hash(password, env.BCRYPT_COST);
}

export function verifyPassword(password: string, hash: string): Promise<boolean> {
  return bcrypt.compare(password, hash);
}

// Compared against when the email is unknown, so response time does not reveal which emails exist.
let dummyHash: Promise<string> | undefined;
export async function burnPasswordCheck(password: string): Promise<void> {
  dummyHash ??= bcrypt.hash('vaharo-dummy-password', env.BCRYPT_COST);
  await bcrypt.compare(password, await dummyHash);
}
