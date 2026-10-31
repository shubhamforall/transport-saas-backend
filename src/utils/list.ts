import { z } from 'zod';

/** Standard list query: page, pageSize, search text, sort from an allowlist. */
export function listQuery<const S extends readonly [string, ...string[]]>(sortFields: S) {
  return z.object({
    page: z.coerce.number().int().min(1).max(10_000).default(1),
    pageSize: z.coerce.number().int().min(1).max(100).default(20),
    q: z.string().trim().max(100).optional(),
    sort: z.enum(sortFields).default(sortFields[0]),
    order: z.enum(['asc', 'desc']).default('desc'),
  });
}

export interface Paged<T> {
  items: T[];
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
}

export function paged<T>(items: T[], total: number, page: number, pageSize: number): Paged<T> {
  return { items, page, pageSize, total, totalPages: Math.max(1, Math.ceil(total / pageSize)) };
}

export function skipTake(page: number, pageSize: number) {
  return { skip: (page - 1) * pageSize, take: pageSize };
}
