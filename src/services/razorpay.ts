import { createHmac } from 'node:crypto';
import { env } from '../config/env.js';
import { AppError } from '../utils/app-error.js';
import { safeEqual } from '../utils/crypto.js';
import { logger } from '../utils/logger.js';

const API = 'https://api.razorpay.com/v1';

export function razorpayConfigured() {
  return Boolean(env.RAZORPAY_KEY_ID && env.RAZORPAY_KEY_SECRET);
}

/** Verifies X-Razorpay-Signature: HMAC-SHA256 of the raw body with the webhook secret. */
export function verifyWebhookSignature(
  rawBody: Buffer,
  signature: string | undefined,
  secret: string,
) {
  if (!signature) return false;
  const expected = createHmac('sha256', secret).update(rawBody).digest('hex');
  return safeEqual(expected, signature);
}

async function call<T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
  if (!razorpayConfigured()) {
    throw new AppError(
      503,
      'BILLING_NOT_CONFIGURED',
      'Online payments are not set up yet. Contact support.',
    );
  }
  const auth = Buffer.from(`${env.RAZORPAY_KEY_ID}:${env.RAZORPAY_KEY_SECRET}`).toString('base64');
  let res: Response;
  try {
    res = await fetch(`${API}${path}`, {
      method,
      headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    throw new AppError(
      502,
      'BILLING_PROVIDER_ERROR',
      'Could not reach the payment provider. Try again.',
    );
  }
  if (!res.ok) {
    // Never pass provider error bodies to clients; log only the status.
    logger.warn({ status: res.status, path }, 'Razorpay API error');
    throw new AppError(502, 'BILLING_PROVIDER_ERROR', 'The payment provider rejected the request.');
  }
  return (await res.json()) as T;
}

export interface RazorpaySubscription {
  id: string;
  status: string;
  short_url?: string;
  current_start?: number | null;
  current_end?: number | null;
}

export function createRazorpaySubscription(
  planId: string,
  totalCount: number,
  notes: Record<string, string>,
) {
  return call<RazorpaySubscription>('POST', '/subscriptions', {
    plan_id: planId,
    total_count: totalCount,
    customer_notify: 1,
    notes,
  });
}

export function cancelRazorpaySubscription(id: string) {
  return call<RazorpaySubscription>('POST', `/subscriptions/${encodeURIComponent(id)}/cancel`, {
    cancel_at_cycle_end: 1,
  });
}
