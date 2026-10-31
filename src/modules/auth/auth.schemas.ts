import { z } from 'zod';
import { PASSWORD_MAX_BYTES } from './password.js';

export const emailSchema = z
  .string()
  .trim()
  .toLowerCase()
  .max(254)
  .pipe(z.email('Enter a valid email address'));

const passwordSchema = z
  .string()
  .min(8, 'Password must be at least 8 characters')
  .refine((p) => Buffer.byteLength(p, 'utf8') <= PASSWORD_MAX_BYTES, 'Password is too long')
  .refine((p) => p.trim().length > 0, 'Password cannot be only spaces');

export const registerSchema = z.object({
  name: z.string().trim().min(2, 'Enter your full name').max(120),
  email: emailSchema,
  password: passwordSchema,
  /** Set when signing up from a team invitation link; lets the invitee skip the email code. */
  invitationToken: z.string().min(20).max(200).optional(),
});

export const loginSchema = z.object({
  email: emailSchema,
  // No strength rules on login: just bounded so huge payloads are not hashed.
  password: z.string().min(1, 'Enter your password').max(200),
});

export type RegisterInput = z.infer<typeof registerSchema>;
export type LoginInput = z.infer<typeof loginSchema>;
