import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { prisma } from '../src/services/prisma.js';
import { testOutbox } from '../src/services/mailer.js';
import {
  PASSWORD,
  browserClient,
  resetDb,
  signedInUser,
  takeVerificationCode,
  uniqueEmail,
} from './helpers.js';

const app = createApp();

beforeAll(resetDb);
beforeEach(() => {
  testOutbox.length = 0;
});
afterAll(() => prisma.$disconnect());

async function pendingUser(name = 'Pending Person') {
  const client = await browserClient(app);
  const email = uniqueEmail('pending');
  const res = await client.post('/api/v1/auth/register', { name, email, password: PASSWORD });
  expect(res.status).toBe(202);
  return { client, email };
}

/** Moves every code for this email back in time, as if the resend wait had passed. */
async function ageCodes(email: string, seconds = 120) {
  const user = await prisma.user.findUniqueOrThrow({ where: { email } });
  await prisma.emailVerificationCode.updateMany({
    where: { userId: user.id },
    data: { createdAt: new Date(Date.now() - seconds * 1000) },
  });
}

const wrongCodeFor = (code: string) => (code === '000000' ? '111111' : '000000');

describe('verification code', () => {
  it('stores only a hash, puts the code in the email, and keeps it out of the email log', async () => {
    const { email } = await pendingUser();
    const mail = testOutbox.find((m) => m.to === email)!;
    const code = /^(\d{6}) is your Vaharo verification code$/.exec(mail.subject)![1]!;
    expect(mail.text).toContain(code);
    expect(mail.text).toContain('10 minutes');
    expect(mail.html).toContain(code);

    const user = await prisma.user.findUniqueOrThrow({ where: { email } });
    const stored = await prisma.emailVerificationCode.findFirstOrThrow({
      where: { userId: user.id },
    });
    expect(stored.codeHash).not.toContain(code);
    expect(stored.codeHash).toMatch(/^[0-9a-f]{64}$/);

    const log = await prisma.emailLog.findFirstOrThrow({
      where: { recipient: email, kind: 'email_verification' },
    });
    expect(log.status).toBe('SENT');
    expect(log.subject).not.toContain(code);
  });

  it('accepts the code with spaces and cannot be used twice', async () => {
    const { client, email } = await pendingUser();
    const code = takeVerificationCode(email);
    const ok = await client.post('/api/v1/auth/verify-email', {
      email,
      code: `${code.slice(0, 3)} ${code.slice(3)}`,
    });
    expect(ok.status).toBe(200);

    const again = await client.post('/api/v1/auth/verify-email', { email, code });
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe('ALREADY_VERIFIED');
  });

  it('counts wrong guesses and locks the code after 5', async () => {
    const { client, email } = await pendingUser();
    const code = takeVerificationCode(email);
    const wrong = wrongCodeFor(code);

    for (let left = 4; left >= 1; left--) {
      const res = await client.post('/api/v1/auth/verify-email', { email, code: wrong });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('CODE_INVALID');
      expect(res.body.error.fieldErrors.code[0]).toContain(`${left} attempt`);
    }
    const fifth = await client.post('/api/v1/auth/verify-email', { email, code: wrong });
    expect(fifth.body.error.code).toBe('CODE_LOCKED');

    // Even the right code no longer works; a new one is needed.
    const right = await client.post('/api/v1/auth/verify-email', { email, code });
    expect(right.status).toBe(400);
    expect(right.body.error.code).toBe('CODE_LOCKED');
    expect((await client.get('/api/v1/auth/me')).status).toBe(401);
  });

  it('rejects an expired code', async () => {
    const { client, email } = await pendingUser();
    const code = takeVerificationCode(email);
    const user = await prisma.user.findUniqueOrThrow({ where: { email } });
    await prisma.emailVerificationCode.updateMany({
      where: { userId: user.id },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });
    const res = await client.post('/api/v1/auth/verify-email', { email, code });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('CODE_EXPIRED');
  });

  it('validates the code format', async () => {
    const client = await browserClient(app);
    const res = await client.post('/api/v1/auth/verify-email', {
      email: uniqueEmail(),
      code: '12ab',
    });
    expect(res.status).toBe(400);
    expect(res.body.error.fieldErrors.code).toBeDefined();
  });
});

describe('resending', () => {
  it('waits 60 seconds between codes, and a new code replaces the old one', async () => {
    const { client, email } = await pendingUser();
    const first = takeVerificationCode(email);

    const tooSoon = await client.post('/api/v1/auth/resend-verification', { email });
    expect(tooSoon.status).toBe(429);
    expect(tooSoon.body.error.code).toBe('RESEND_TOO_SOON');

    await ageCodes(email);
    const resent = await client.post('/api/v1/auth/resend-verification', { email });
    expect(resent.status).toBe(202);
    const second = takeVerificationCode(email);

    if (first !== second) {
      const old = await client.post('/api/v1/auth/verify-email', { email, code: first });
      expect(old.status).toBe(400);
    }
    expect((await client.post('/api/v1/auth/verify-email', { email, code: second })).status).toBe(
      200,
    );
  });

  it('allows at most 5 codes an hour', async () => {
    const { client, email } = await pendingUser();
    const user = await prisma.user.findUniqueOrThrow({ where: { email } });
    await ageCodes(email);
    await prisma.emailVerificationCode.createMany({
      data: Array.from({ length: 4 }, () => ({
        userId: user.id,
        codeHash: '0'.repeat(64),
        expiresAt: new Date(Date.now() + 60_000),
        usedAt: new Date(),
        createdAt: new Date(Date.now() - 30 * 60_000),
      })),
    });
    const res = await client.post('/api/v1/auth/resend-verification', { email });
    expect(res.status).toBe(429);
    expect(res.body.error.code).toBe('TOO_MANY_CODES');
  });

  it('answers the same for unknown and already verified emails, without sending', async () => {
    const verified = await signedInUser(app);
    testOutbox.length = 0;
    const client = await browserClient(app);
    const unknown = await client.post('/api/v1/auth/resend-verification', {
      email: uniqueEmail('nobody'),
    });
    const done = await client.post('/api/v1/auth/resend-verification', { email: verified.email });
    expect(unknown.status).toBe(202);
    expect(done.status).toBe(202);
    expect(done.body).toEqual(unknown.body);
    expect(testOutbox).toHaveLength(0);
  });
});

describe('unverified accounts', () => {
  it('cannot sign in; the right password sends a new code, a wrong one reveals nothing', async () => {
    const { email } = await pendingUser();
    takeVerificationCode(email);
    await ageCodes(email);
    const client = await browserClient(app);

    const wrong = await client.post('/api/v1/auth/login', { email, password: 'wrong-password' });
    expect(wrong.status).toBe(401);
    expect(wrong.body.error.code).toBe('INVALID_CREDENTIALS');
    expect(testOutbox).toHaveLength(0);

    const right = await client.post('/api/v1/auth/login', { email, password: PASSWORD });
    expect(right.status).toBe(403);
    expect(right.body.error.code).toBe('EMAIL_NOT_VERIFIED');
    expect(right.headers['set-cookie']?.toString() ?? '').not.toMatch(/vaharo_at=/);

    const code = takeVerificationCode(email);
    expect((await client.post('/api/v1/auth/verify-email', { email, code })).status).toBe(200);
    expect((await client.post('/api/v1/auth/login', { email, password: PASSWORD })).status).toBe(
      200,
    );
  });

  it('do not hold the email: signing up again replaces the name and password', async () => {
    const { email } = await pendingUser('Squatter');
    takeVerificationCode(email);
    await ageCodes(email);

    const owner = await browserClient(app);
    const res = await owner.post('/api/v1/auth/register', {
      name: 'Real Owner',
      email,
      password: 'Real-Owner-Pass1',
    });
    expect(res.status).toBe(202);
    const code = takeVerificationCode(email);
    const verified = await owner.post('/api/v1/auth/verify-email', { email, code });
    expect(verified.status).toBe(200);
    expect(verified.body.user.name).toBe('Real Owner');

    const squatter = await browserClient(app);
    expect((await squatter.post('/api/v1/auth/login', { email, password: PASSWORD })).status).toBe(
      401,
    );
    expect(await prisma.user.count({ where: { email } })).toBe(1);
  });

  it('a completed password reset also verifies the email', async () => {
    const { email } = await pendingUser();
    takeVerificationCode(email);
    const client = await browserClient(app);
    await client.post('/api/v1/auth/forgot-password', { email });
    const token = decodeURIComponent(/token=([^\s&]+)/.exec(testOutbox.at(-1)!.text)![1]!);
    expect(
      (await client.post('/api/v1/auth/reset-password', { token, password: 'Brand-New-Pass1' }))
        .status,
    ).toBe(204);
    expect(
      (await client.post('/api/v1/auth/login', { email, password: 'Brand-New-Pass1' })).status,
    ).toBe(200);
  });
});
