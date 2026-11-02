import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { PLATFORM_ADMIN_EMAILS } from '../src/config/platform-admins.js';
import { prisma } from '../src/services/prisma.js';
import { testOutbox } from '../src/services/mailer.js';
import { browserClient, resetDb } from './helpers.js';

const app = createApp();

const valid = {
  name: 'Ravi Sharma',
  email: 'Ravi@Example.com',
  phone: '+91 98765 43210',
  company: 'Deccan Roadways Co.',
  topic: 'demo',
  message: 'We run 12 trucks and want to see invoicing.',
};

beforeAll(resetDb);
beforeEach(() => {
  testOutbox.length = 0;
});
afterAll(() => prisma.$disconnect());

describe('contact form', () => {
  it('emails the Super Admins with the visitor as Reply-To', async () => {
    const client = await browserClient(app);
    const res = await client.post('/api/v1/contact', valid).expect(202);
    expect(res.body).toEqual({ received: true });

    expect(testOutbox.map((m) => m.to)).toEqual([...PLATFORM_ADMIN_EMAILS]);
    const mail = testOutbox[0]!;
    expect(mail.replyTo).toBe('ravi@example.com');
    expect(mail.subject).toBe('Vaharo enquiry: Book a demo from Ravi Sharma');
    expect(mail.text).toContain('Company: Deccan Roadways Co.');
    expect(mail.text).toContain('We run 12 trucks');

    const log = await prisma.emailLog.findFirstOrThrow({ where: { kind: 'contact' } });
    expect(log.status).toBe('SENT');
    expect(log.tenantId).toBeNull();
  });

  it('keeps line breaks out of the subject', async () => {
    const client = await browserClient(app);
    await client.post('/api/v1/contact', { ...valid, name: 'Ravi\r\nBcc: x@evil.test' }).expect(202);
    expect(testOutbox[0]!.subject).not.toMatch(/[\r\n]/);
  });

  it('rejects bad input with field errors', async () => {
    const client = await browserClient(app);
    const res = await client
      .post('/api/v1/contact', { ...valid, email: 'nope', message: 'hi', topic: 'spam' })
      .expect(400);
    expect(Object.keys(res.body.error.fieldErrors).sort()).toEqual(['email', 'message', 'topic']);
    expect(testOutbox).toHaveLength(0);
  });

  it('quietly drops messages that fill the hidden field', async () => {
    const client = await browserClient(app);
    await client.post('/api/v1/contact', { ...valid, website: 'http://spam.test' }).expect(202);
    expect(testOutbox).toHaveLength(0);
  });

  it('needs the CSRF token', async () => {
    const client = await browserClient(app);
    await client.agent.post('/api/v1/contact').send(valid).expect(403);
  });
});
