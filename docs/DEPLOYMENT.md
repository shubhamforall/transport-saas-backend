# Deployment, backups and rollback

Target: Hostinger Business plan (Node.js app + MySQL), with the web app as static files.
Recommended layout: **`app.<your-domain>`** serves the web app, **`api.<your-domain>`** serves
this API. Same parent domain keeps the auth cookies "same-site", so no extra cookie settings
are needed.

> Nothing here has been run against a live Hostinger account yet. Work through the checklist
> in section 1 on the real plan first and note anything that differs.

## 1. Confirm on the hosting plan (once)

- [ ] Node.js 20 or newer can run a long-running app (`npm start` → `node dist/server.js`).
- [ ] Environment variables can be set in the panel (all names from `.env.example`).
- [ ] MySQL 8 database + user created; note host, port and connection limit.
- [ ] Outbound SMTP is allowed (port 587 or 465) for invoice and password-reset emails.
- [ ] HTTPS certificates are active for both subdomains.
- [ ] Request timeout is at least 30 s (PDF + email of large invoices).
- [ ] SSH or a cron feature is available for the daily database backup.
- [ ] `mysqldump` is available (or use the panel's export as a fallback).

Background workers are **not** required: emails are sent during the request and logged.

## 2. Environment variables (API)

Set these in the hosting panel, never in a committed file.

| Variable                                                              | Production value                                                                                |
| --------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| `NODE_ENV`                                                            | `production`                                                                                    |
| `PORT`                                                                | as given by the host                                                                            |
| `WEB_ORIGIN`                                                          | `https://app.<your-domain>` (comma-separate if several)                                         |
| `APP_BASE_URL`                                                        | `https://app.<your-domain>` (used in email links)                                               |
| `DATABASE_URL`                                                        | `mysql://USER:PASSWORD@HOST:3306/DBNAME`                                                        |
| `JWT_ACCESS_SECRET`                                                   | 48+ random bytes: `node -e "console.log(require('crypto').randomBytes(48).toString('base64'))"` |
| `JWT_ACCESS_TTL`, `REFRESH_TOKEN_TTL_DAYS`                            | `15m`, `30`                                                                                     |
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE`, `SMTP_USER`, `SMTP_PASSWORD` | from the email provider                                                                         |
| `SMTP_FROM_NAME`, `SMTP_FROM_EMAIL`                                   | e.g. `Vaharo`, `billing@<your-domain>`                                                          |
| `TRIAL_DAYS`, `PAST_DUE_GRACE_DAYS`                                   | e.g. `14`, `7`                                                                                  |
| `RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET`                              | live keys (test keys on staging)                                                                |
| `RAZORPAY_WEBHOOK_SECRET`                                             | the secret entered when creating the webhook in Razorpay                                        |
| `LOG_LEVEL`                                                           | `info`                                                                                          |

The API **refuses to start** in production with unsafe settings (placeholder secret, `http://`
origins, missing SMTP). Read the startup log if it does not come up.

Do **not** set `SHADOW_DATABASE_URL`, `TEST_DATABASE_URL` or `SEED_DEMO_PASSWORD` in production.

## 3. Deploy the API

**Hostinger Node.js web app (GitHub auto-deploy):** no build-command changes are needed. With
`NODE_ENV=production` set in the panel, `npm run build` first runs `scripts/migrate-on-deploy.mjs`
(npm `prebuild` hook), which applies pending migrations with `prisma migrate deploy`. Build-time
tools (TypeScript, Prisma CLI, `@types/*` used by the compiler) are regular dependencies because
production installs skip devDependencies. Set `SKIP_DB_MIGRATE=1` to build without a database.

Manual / SSH deploy:

```bash
git pull                      # or upload the release
npm ci                        # installs and runs `prisma generate`
npm run build                 # TypeScript -> dist/
npm run db:deploy             # apply pending migrations (never `migrate dev` in production)
npm start                     # or restart the Node app in the panel
curl https://api.<your-domain>/health    # {"status":"ok",...}
```

- Take a database backup **before** `db:deploy` (section 6).
- Migrations are additive in this release. Review any future migration that drops or renames
  columns before running it.
- Never run `npm run db:seed` in production (it refuses anyway).

**Super Admins** are listed in `src/config/platform-admins.ts` (currently
`patilshubham0514@gmail.com`). A listed account is promoted automatically once its email is
verified: on sign-up verification, on every sign-in, and at server start (so on every deploy).
Nothing happens if the account does not exist yet. To add someone else ad hoc:
`npm run platform:admin -- someone@<your-domain>`.

Then sign in, open **Super Admin → Plans** and set real prices, limits and Razorpay plan ids.
Companies only get a free trial once at least one active plan exists.

## 4. Deploy the web app

Build in `transport-saas-frontend` with the production API URL:

```bash
VITE_API_BASE_URL=https://api.<your-domain>/api/v1 npm run build
```

Upload the contents of `dist/` (including `.htaccess`) to the `app.` subdomain's web root.
The `.htaccess` file sends all routes to `index.html`, forces HTTPS and sets security and cache
headers.

## 5. Payments (Razorpay)

1. In Razorpay, create one subscription **plan** per Vaharo plan; copy each `plan_...` id into
   Super Admin → Plans.
2. Add a webhook: URL `https://api.<your-domain>/api/v1/billing/webhooks/razorpay`, a strong
   secret (same value as `RAZORPAY_WEBHOOK_SECRET`), events: `subscription.activated`,
   `subscription.charged`, `subscription.pending`, `subscription.halted`, `subscription.paused`,
   `subscription.resumed`, `subscription.cancelled`, `subscription.completed`.
3. Test with Razorpay **test** keys on a staging copy first. Check **Super Admin → Webhook
   events**: each event should show _Processed_; repeats show nothing new (they are deduplicated).

Paid access is granted only by signed webhooks, never by the browser redirect.

## 6. Backups and restore

**Daily backup** (cron on the server, e.g. 02:30 IST):

```bash
DB_HOST=... DB_USER=... DB_PASSWORD=... DB_NAME=... KEEP=14 ./scripts/backup-db.sh
```

This writes `backups/vaharo-YYYYMMDD-HHMMSS.sql.gz` with a consistent snapshot
(`--single-transaction`) and keeps the newest 14. **Copy the files off the server** (e.g. to
Google Drive or another host) — a backup on the same disk is not a backup. Hostinger's own
backups are a useful extra, not a replacement.

**Restore** (into a new, empty database first; never straight over the live one):

```bash
mysql -h HOST -u USER -p -e "CREATE DATABASE vaharo_restore CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci"
gunzip -c backups/vaharo-YYYYMMDD-HHMMSS.sql.gz | mysql -h HOST -u USER -p vaharo_restore
```

Check row counts against expectations, then point `DATABASE_URL` at the restored database (or
rename databases) and restart the API.

**Restore drill:** run a restore into a scratch database at least monthly. Last drill:
2026-10-31 on the local MySQL 8.4 copy: dump + restore of all tables, row counts matched for
tenants, users, memberships, customers, vehicles, jobs, invoices, invoice items, payments,
allocations, audit logs and migrations.

## 7. Rollback

1. Keep the previous release folder / git tag (e.g. `git tag release-2026-11-01`).
2. To roll back code: check out the previous tag, `npm ci && npm run build`, restart.
3. If the bad release ran a migration: restore the backup taken just before it (section 6),
   then deploy the previous tag. Do not try to hand-edit the schema.
4. Web app: re-upload the previous `dist/` (keep the last two builds zipped).

## 8. Smoke test after every deploy

On production (or staging), with a test company:

- [ ] `GET /health` is ok.
- [ ] Sign up, sign in, sign out; password reset email arrives.
- [ ] Create a company; it starts on a trial.
- [ ] Add a customer and a vehicle; create a Mumbai → Pune job; mark it delivered.
- [ ] Create the invoice from the job, issue it, download the PDF (check ₹ and layout).
- [ ] Email the invoice to yourself; it shows _Sent_ in the email history.
- [ ] Record a partial payment; balance and dashboard update.
- [ ] Sign in as a second company: the first company's records are not visible.
- [ ] Super Admin: the company appears with its trial.

## 9. Support notes

- Every API response has an `X-Request-Id`; users see it in error messages. Search logs for it.
- Logs never contain passwords, tokens, cookies or CSRF values (redacted).
- To suspend a company (e.g. abuse or non-payment): Super Admin → Companies → Suspend, with a
  reason (audited). Data is kept.
