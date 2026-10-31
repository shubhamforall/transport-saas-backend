import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { prisma } from '../src/services/prisma.js';
import { sha256 } from '../src/utils/crypto.js';
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
afterAll(() => prisma.$disconnect());

/** Registers and verifies, returning the verify response (it carries the session cookies). */
async function registerAndVerify(name: string) {
  const client = await browserClient(app);
  const email = uniqueEmail();
  await client.post('/api/v1/auth/register', { name, email, password: PASSWORD });
  const res = await client.post('/api/v1/auth/verify-email', {
    email,
    code: takeVerificationCode(email),
  });
  return { client, email, res };
}

function cookieValue(res: request.Response, name: string): string | undefined {
  const raw = res.headers['set-cookie'] as unknown as string[] | undefined;
  const line = raw?.find((c) => c.startsWith(`${name}=`));
  return line?.split(';')[0]?.slice(name.length + 1);
}

describe('registration', () => {
  it('creates an unverified user, emails a code, and signs in only after the code', async () => {
    const client = await browserClient(app);
    const email = uniqueEmail();
    const res = await client.post('/api/v1/auth/register', {
      name: '  Asha Kulkarni ',
      email: `  ${email.toUpperCase()} `,
      password: PASSWORD,
    });

    expect(res.status).toBe(202);
    expect(res.body).toEqual({ verificationRequired: true, email, emailSent: true });
    expect(res.headers['set-cookie']?.toString() ?? '').not.toMatch(/vaharo_at=|vaharo_rt=/);
    expect((await client.get('/api/v1/auth/me')).status).toBe(401);

    const stored = await prisma.user.findUniqueOrThrow({ where: { email } });
    expect(stored.name).toBe('Asha Kulkarni');
    expect(stored.emailVerifiedAt).toBeNull();
    expect(stored.passwordHash).toMatch(/^\$2[aby]\$/);

    const code = takeVerificationCode(email);
    const verified = await client.post('/api/v1/auth/verify-email', { email, code });
    expect(verified.status).toBe(200);
    expect(verified.body.user).toMatchObject({ name: 'Asha Kulkarni', email });
    expect(verified.body.memberships).toEqual([]);
    expect(JSON.stringify(verified.body)).not.toMatch(/passwordHash|\$2[aby]\$/);

    const cookies = (verified.headers['set-cookie'] as unknown as string[]).join('\n');
    expect(cookies).toMatch(/vaharo_at=[^;]+;.*HttpOnly/);
    expect(cookies).toMatch(/vaharo_rt=[^;]+;.*Path=\/api\/v1\/auth;.*HttpOnly/);

    const me = await client.get('/api/v1/auth/me');
    expect(me.status).toBe(200);
    expect(me.body.user.email).toBe(email);
    expect(
      (await prisma.user.findUniqueOrThrow({ where: { email } })).emailVerifiedAt,
    ).not.toBeNull();
  });

  it('rejects a duplicate email with 409 and a field error', async () => {
    const first = await signedInUser(app);
    const client = await browserClient(app);
    const res = await client.post('/api/v1/auth/register', {
      name: 'Someone Else',
      email: first.email,
      password: PASSWORD,
    });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('EMAIL_TAKEN');
    expect(res.body.error.fieldErrors.email).toBeDefined();
  });

  it('validates input on the server', async () => {
    const client = await browserClient(app);
    const res = await client.post('/api/v1/auth/register', {
      name: 'A',
      email: 'not-an-email',
      password: 'short',
    });
    expect(res.status).toBe(400);
    expect(Object.keys(res.body.error.fieldErrors)).toEqual(
      expect.arrayContaining(['name', 'email', 'password']),
    );
  });

  it('rejects passwords longer than 72 bytes (bcrypt limit)', async () => {
    const client = await browserClient(app);
    const res = await client.post('/api/v1/auth/register', {
      name: 'Long Password',
      email: uniqueEmail(),
      password: 'é'.repeat(40), // 80 bytes in UTF-8
    });
    expect(res.status).toBe(400);
    expect(res.body.error.fieldErrors.password).toBeDefined();
  });
});

describe('login and logout', () => {
  it('signs in with the right password and returns the same error for wrong password or unknown email', async () => {
    const user = await signedInUser(app);

    const ok = await (
      await browserClient(app)
    ).post('/api/v1/auth/login', { email: user.email, password: PASSWORD });
    expect(ok.status).toBe(200);
    expect(ok.body.user.email).toBe(user.email);

    const wrong = await (
      await browserClient(app)
    ).post('/api/v1/auth/login', { email: user.email, password: 'nope-nope' });
    const unknown = await (
      await browserClient(app)
    ).post('/api/v1/auth/login', {
      email: uniqueEmail('ghost'),
      password: 'nope-nope',
    });
    expect(wrong.status).toBe(401);
    expect(unknown.status).toBe(401);
    expect(wrong.body.error.code).toBe('INVALID_CREDENTIALS');
    expect(unknown.body.error.message).toBe(wrong.body.error.message);
  });

  it('disabled users cannot sign in and lose access immediately', async () => {
    const user = await signedInUser(app);
    await prisma.user.update({ where: { id: user.userId }, data: { status: 'DISABLED' } });

    expect((await user.get('/api/v1/auth/me')).status).toBe(401);
    const login = await (
      await browserClient(app)
    ).post('/api/v1/auth/login', { email: user.email, password: PASSWORD });
    expect(login.status).toBe(401);
  });

  it('logout revokes the refresh token and clears cookies', async () => {
    const user = await signedInUser(app);
    const res = await user.post('/api/v1/auth/logout');
    expect(res.status).toBe(204);
    expect((await user.get('/api/v1/auth/me')).status).toBe(401);
    expect((await user.post('/api/v1/auth/refresh')).status).toBe(401);

    const tokens = await prisma.refreshToken.findMany({ where: { userId: user.userId } });
    expect(tokens.every((t) => t.revokedAt)).toBe(true);
  });

  it('GET /auth/me without a session returns 401', async () => {
    const res = await request(app).get('/api/v1/auth/me');
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('UNAUTHORIZED');
  });

  it('rejects a forged access token', async () => {
    const res = await request(app)
      .get('/api/v1/auth/me')
      .set('Cookie', 'vaharo_at=eyJhbGciOiJub25lIn0.eyJzdWIiOiJ4In0.');
    expect(res.status).toBe(401);
  });
});

describe('refresh token rotation', () => {
  it('rotates the refresh token and stores only its hash', async () => {
    const { client, res: reg } = await registerAndVerify('Rotate Me');
    const first = cookieValue(reg, 'vaharo_rt')!;
    expect(
      await prisma.refreshToken.findUnique({ where: { tokenHash: sha256(first) } }),
    ).not.toBeNull();
    expect(await prisma.refreshToken.findFirst({ where: { tokenHash: first } })).toBeNull();

    const refreshed = await client.post('/api/v1/auth/refresh');
    expect(refreshed.status).toBe(204);
    const second = cookieValue(refreshed, 'vaharo_rt');
    expect(second).toBeTruthy();
    expect(second).not.toBe(first);
    expect((await client.get('/api/v1/auth/me')).status).toBe(200);
  });

  it('reusing an old refresh token after the grace window revokes the whole family', async () => {
    const { client, res: reg } = await registerAndVerify('Stolen Token');
    const userId = reg.body.user.id as string;
    const stolen = cookieValue(reg, 'vaharo_rt')!;
    expect((await client.post('/api/v1/auth/refresh')).status).toBe(204);

    // Pretend the rotation happened a minute ago.
    await prisma.refreshToken.update({
      where: { tokenHash: sha256(stolen) },
      data: { revokedAt: new Date(Date.now() - 60_000) },
    });

    const attacker = await request(app)
      .post('/api/v1/auth/refresh')
      .set('Cookie', [`vaharo_rt=${stolen}`, `vaharo_csrf=${client.csrf}`])
      .set('X-CSRF-Token', client.csrf);
    expect(attacker.status).toBe(401);

    const active = await prisma.refreshToken.count({ where: { userId, revokedAt: null } });
    expect(active).toBe(0);
    expect((await client.post('/api/v1/auth/refresh')).status).toBe(401);
  });
});

describe('CSRF protection', () => {
  it('rejects state-changing requests without a matching token', async () => {
    const noToken = await request(app)
      .post('/api/v1/auth/login')
      .send({ email: uniqueEmail(), password: PASSWORD });
    expect(noToken.status).toBe(403);
    expect(noToken.body.error.code).toBe('CSRF_INVALID');

    const client = await browserClient(app);
    const mismatch = await client.agent
      .post('/api/v1/auth/login')
      .set('X-CSRF-Token', 'not-the-token')
      .send({ email: uniqueEmail(), password: PASSWORD });
    expect(mismatch.status).toBe(403);
  });
});

describe('rate limiting', () => {
  it('limits repeated login attempts', async () => {
    const limited = createApp({ authRateLimitMax: 3 });
    const client = await browserClient(limited);
    const attempt = () =>
      client.post('/api/v1/auth/login', { email: uniqueEmail(), password: 'wrong-pass' });
    for (let i = 0; i < 3; i++) expect((await attempt()).status).toBe(401);
    const blocked = await attempt();
    expect(blocked.status).toBe(429);
    expect(blocked.body.error.code).toBe('TOO_MANY_REQUESTS');
  });
});

describe('profile', () => {
  it('updates the name and validates it', async () => {
    const user = await signedInUser(app, 'Old Name');
    const res = await user.patch('/api/v1/auth/me', { name: '  New Name ' });
    expect(res.status).toBe(200);
    expect(res.body.user.name).toBe('New Name');
    expect((await user.patch('/api/v1/auth/me', { name: 'A' })).status).toBe(400);
    // Email cannot be changed here.
    expect((await user.patch('/api/v1/auth/me', { name: 'Ok Name', email: 'x@y.co' })).status).toBe(
      400,
    );
    expect(
      await prisma.auditLog.count({
        where: { actorUserId: user.userId, action: 'user.profile_updated' },
      }),
    ).toBe(1);
  });

  it('requires a session', async () => {
    const client = await browserClient(app);
    expect((await client.patch('/api/v1/auth/me', { name: 'Someone' })).status).toBe(401);
  });

  it('changes the password with the current one, signs out other devices, keeps this one', async () => {
    const user = await signedInUser(app);
    const other = await browserClient(app);
    await other.post('/api/v1/auth/login', { email: user.email, password: PASSWORD });

    const wrong = await user.post('/api/v1/auth/change-password', {
      currentPassword: 'not-my-password',
      newPassword: 'Brand-New-Pass1',
    });
    expect(wrong.status).toBe(400);
    expect(wrong.body.error.fieldErrors.currentPassword).toBeDefined();

    const same = await user.post('/api/v1/auth/change-password', {
      currentPassword: PASSWORD,
      newPassword: PASSWORD,
    });
    expect(same.body.error.code).toBe('SAME_PASSWORD');

    const ok = await user.post('/api/v1/auth/change-password', {
      currentPassword: PASSWORD,
      newPassword: 'Brand-New-Pass1',
    });
    expect(ok.status).toBe(204);
    expect((await user.post('/api/v1/auth/refresh')).status).toBe(204);
    expect((await other.post('/api/v1/auth/refresh')).status).toBe(401);

    const fresh = await browserClient(app);
    expect(
      (await fresh.post('/api/v1/auth/login', { email: user.email, password: PASSWORD })).status,
    ).toBe(401);
    expect(
      (await fresh.post('/api/v1/auth/login', { email: user.email, password: 'Brand-New-Pass1' }))
        .status,
    ).toBe(200);
  });
});
