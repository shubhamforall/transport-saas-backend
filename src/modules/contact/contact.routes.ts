import { Router } from 'express';
import { rateLimit } from 'express-rate-limit';
import { z } from 'zod';
import { PLATFORM_ADMIN_EMAILS } from '../../config/platform-admins.js';
import { prisma } from '../../services/prisma.js';
import { MailError, sendMail, simpleHtml } from '../../services/mailer.js';
import { AppError } from '../../utils/app-error.js';
import { logger } from '../../utils/logger.js';

export const CONTACT_TOPICS = ['demo', 'pricing', 'support', 'partnership', 'other'] as const;

const TOPIC_LABELS: Record<(typeof CONTACT_TOPICS)[number], string> = {
  demo: 'Book a demo',
  pricing: 'Plans and pricing',
  support: 'Help with my account',
  partnership: 'Partnership',
  other: 'Something else',
};

/** One line of plain text: no line breaks, so it is safe in an email subject. */
const oneLine = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .transform((s) => s.replace(/\s+/g, ' '));

export const contactSchema = z
  .object({
    name: oneLine(120).pipe(z.string().min(2, 'Enter your name')),
    email: z.string().trim().toLowerCase().max(254).pipe(z.email('Enter a valid email')),
    phone: oneLine(20)
      .pipe(z.string().regex(/^[0-9+()\- ]*$/, 'Use digits, spaces, + or -'))
      .optional(),
    company: oneLine(160).optional(),
    topic: z.enum(CONTACT_TOPICS, 'Choose a topic'),
    message: z
      .string()
      .trim()
      .min(10, 'Tell us a little more (at least 10 characters)')
      .max(4000, 'Keep the message under 4000 characters'),
    /** Hidden "website" field. People leave it empty; simple bots fill it in. */
    website: z.string().max(200).optional(),
  })
  .strict();

export type ContactInput = z.infer<typeof contactSchema>;

const contactLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: 5,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  handler: (_req, _res, next) =>
    next(
      new AppError(429, 'TOO_MANY_REQUESTS', 'Too many messages. Try again in an hour or email us.'),
    ),
});

/** Sends a contact-form message to every Super Admin. The sender's address goes in Reply-To. */
export async function sendContactMessage(input: ContactInput) {
  if (input.website) return; // bot: pretend it worked
  const subject = `Vaharo enquiry: ${TOPIC_LABELS[input.topic]} from ${input.name}`;
  const lines = [
    `Name: ${input.name}`,
    `Email: ${input.email}`,
    input.phone ? `Phone: ${input.phone}` : null,
    input.company ? `Company: ${input.company}` : null,
    `Topic: ${TOPIC_LABELS[input.topic]}`,
  ].filter((l): l is string => l !== null);
  const text = `${lines.join('\n')}\n\n${input.message}`;

  let delivered = 0;
  for (const to of PLATFORM_ADMIN_EMAILS) {
    const log = await prisma.emailLog.create({
      data: { kind: 'contact', recipient: to, subject, attemptCount: 1 },
    });
    try {
      const sent = await sendMail({
        to,
        replyTo: input.email,
        subject,
        text,
        html: simpleHtml([lines.join('\n'), input.message]),
      });
      await prisma.emailLog.update({
        where: { id: log.id },
        data: { status: 'SENT', sentAt: new Date(), providerMessageId: sent.messageId },
      });
      delivered += 1;
    } catch (err) {
      const reason = err instanceof MailError ? err.safeMessage : 'Email could not be sent.';
      logger.warn({ emailLogId: log.id }, 'Contact message not delivered');
      await prisma.emailLog.update({
        where: { id: log.id },
        data: { status: 'FAILED', lastErrorSafe: reason },
      });
    }
  }
  if (delivered === 0) {
    throw new AppError(
      503,
      'EMAIL_FAILED',
      'We could not send your message right now. Please try again in a few minutes.',
    );
  }
}

/** Public: the marketing site's contact form. */
export const contactRouter = Router();
contactRouter.post('/', contactLimiter, async (req, res) => {
  await sendContactMessage(contactSchema.parse(req.body));
  res.status(202).json({ received: true });
});
