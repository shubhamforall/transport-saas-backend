# Decision log

Record each decision with date, choice, rationale and impact.

## 2026-10-28 — Authentication token storage

- **Choice:** Short-lived JWT access token and a rotating refresh token, both in HttpOnly cookies
  (`Secure` in production, `SameSite=Lax`). Refresh tokens stored hashed in the database so they
  can be revoked. CSRF protection added for state-changing requests.
- **Rationale:** Tokens are not readable by JavaScript, which limits damage from XSS.
- **Impact:** Frontend uses `credentials: 'include'`; CORS must list exact frontend origins with
  `credentials: true`. If frontend and API are on different sites, cookie `SameSite` settings
  need revisiting at deployment.

## 2026-10-28 — Node.js version

- **Choice:** Target Node 20 LTS or newer (`engines.node >= 20`). Developed on Node 22.
- **Rationale:** Hostinger plan version not yet confirmed; 20 is the safe floor.
- **Impact:** Confirm the plan's Node version before Milestone 8.

## 2026-10-28 — Framework versions

- **Choice:** Express 5, Zod 4, TypeScript 6, Vitest 5, ESM modules (`"type": "module"`).
- **Rationale:** Current stable releases; Express 5 forwards async errors to the error handler.
- **Impact:** Imports inside `src` use `.js` extensions (NodeNext resolution).

## 2026-10-28 — Repositories

- **Choice:** Two independent repositories, `transport-saas-backend` and
  `transport-saas-frontend`. No monorepo, no shared filesystem.
- **Impact:** API contract lives in `docs/API.md`; frontend types are kept in step manually.

## 2026-10-31 — Money, quantities and tax as integers

- **Choice:** Money is integer paise in 32-bit INT columns; one amount is capped at ₹1 crore and an
  invoice total at about ₹21.4 crore (the INT limit). Quantities/capacities are thousandths.
  GST rates are basis points. Invoice maths uses BigInt internally and rounds half-up per paisa;
  CGST and SGST are each computed at half the rate and rounded separately.
- **Rationale:** No floating point anywhere money is calculated; INT keeps JSON and SQL simple.
- **Impact:** If a customer ever needs bigger invoices, migrate the money columns to BIGINT.

## 2026-10-31 — Job and invoice integrity

- **Choice:** A job can be linked to one non-cancelled invoice at a time (unique row in
  `invoice_jobs`). Creating a draft from a job reserves it; deleting the draft or cancelling
  the invoice deletes the link, so a corrected invoice can bill the job again (cancellation is
  audited with the released job ids). Issue claims the draft with a conditional update before
  taking the next number, so parallel issue requests can neither double-number nor skip numbers.
  Numbers are `{prefix}/{YY-YY}/{NNNN}` per company and Indian financial year.
- **Impact:** Multi-job invoices are supported for one customer; duplicate billing is blocked
  by the database even under concurrency (tested).

## 2026-10-31 — Payments

- **Choice:** MVP payments pay one invoice; the schema allows several allocations later. The
  balance check and increment are a single conditional UPDATE, so concurrent payments cannot
  over-pay. Invoices with payments cannot be cancelled until the payments are voided.

## 2026-10-31 — Email delivery without a queue

- **Choice:** Emails are sent during the request (two attempts, short SMTP timeouts) and every
  attempt is stored in `email_logs` with a safe error summary. A second send within two minutes
  of one still in progress is refused. Without SMTP, development writes `.eml` files to
  `tmp/outbox`; production refuses to start.
- **Rationale:** Hostinger may not allow background workers (project plan section 5).

## 2026-10-31 — Team roles

- **Choice:** Rank rule: Owner > Admin > Operations/Accounts/Viewer. You can only invite, change
  or remove people ranked below you, and only assign roles below your own. Nobody can change
  their own role. Ownership moves only through the confirmed transfer flow, so a company always
  has an Owner. Invitations are emailed, single-use, expire in 7 days and must be accepted by an
  account with the invited email.

## 2026-10-31 — Subscriptions and read-only mode

- **Choice:** Plans live in the database (prices in the seed are placeholders). New companies get
  a trial on the first active plan; with no plans configured nothing is limited. Pending
  checkouts do not change access; only signed Razorpay webhooks do, and each event id is
  processed once. Lapsed companies become read-only (HTTP 402 on writes) except billing routes.
  Super Admin can set a manual subscription (e.g. pilots paying by bank transfer), audited.
- **Impact:** Webhooks are applied in arrival order; out-of-order delivery could briefly show an
  older state until the next event. Review before high volume.

## 2026-10-31 — Super Admin privacy

- **Choice:** Super Admin sees company metadata, members, record counts and subscription data,
  never customer, job or invoice contents. Audit details are shown only for platform and
  subscription actions. Platform admins are granted with a server-side CLI command only.

## 2026-10-31 — Prisma 7 with the MariaDB driver adapter

- **Choice:** Prisma 7 (`prisma-client` generator, output in `src/generated/prisma`, not committed)
  with `@prisma/adapter-mariadb`, which works with MySQL 8. Config lives in `prisma.config.ts`.
- **Rationale:** Prisma 7 requires a driver adapter; the MariaDB connector is the supported one
  for MySQL and is pure JavaScript (no native build on Hostinger).
- **Impact:** `npm install` runs `prisma generate`. Production applies migrations with
  `npm run db:deploy`, never `migrate dev`.

## 2026-10-31 — Password hashing

- **Choice:** bcrypt via `bcryptjs` (pure JS), cost 12. Passwords 8+ characters, max 72 bytes.
- **Rationale:** No native compilation, so it installs on any Hostinger Node plan. bcrypt
  ignores bytes after 72, so longer passwords are rejected instead of silently truncated.
- **Impact:** Can move to Argon2 later by re-hashing on next successful login.

## 2026-10-31 — Session and CSRF details

- **Choice:** Access JWT (HS256, 15 min) in `vaharo_at`; random refresh token in `vaharo_rt`
  scoped to `/api/v1/auth`, stored as SHA-256 hash, rotated on every use, grouped in families.
  Reuse of an old token more than 30 seconds after rotation revokes the whole family (theft
  signal); within 30 seconds it is treated as a race between tabs. CSRF is a double-submit token:
  HttpOnly cookie plus an `X-CSRF-Token` header whose value the app gets from `GET /auth/csrf`.
- **Rationale:** Reading the token from the response body (not `document.cookie`) keeps working
  if the frontend and API end up on different subdomains.
- **Impact:** User status is checked on every authenticated request, so disabling a user takes
  effect immediately.

## 2026-10-31 — Registration reveals existing emails

- **Choice:** Registering an existing email returns `409 EMAIL_TAKEN`. Login never reveals
  whether an email exists (same error and similar timing).
- **Rationale:** Clear sign-up UX for small businesses outweighs enumeration risk at MVP stage;
  registration is rate-limited.
- **Impact:** Revisit if email verification is added (could switch to "check your inbox").

## 2026-10-31 — Password reset

- **Choice:** Built in Milestone 5 with email: 1-hour single-use links (hash stored), the newest
  link only, same response whether or not the email exists, and all sessions signed out after a
  reset.

## 2026-10-31 — Tenant access rules

- **Choice:** Non-members, unknown ids and malformed ids all get `404`. Suspended companies get
  `403 TENANT_SUSPENDED`. A user can own at most 5 companies (`MAX_OWNED_TENANTS`).
- **Rationale:** 404 avoids confirming that another company exists. The owner limit stops
  runaway workspace creation until plans define real limits (Milestone 7).
- **Impact:** Routes check permissions (e.g. `tenant.update`), never role names; the policy is
  in `src/services/permissions.ts`.

## 2026-10-31 — Local database

- **Choice:** Development MySQL 8.4 runs in Docker as `vaharo-mysql` on port 3307 with
  `vaharo`, `vaharo_test` and `vaharo_shadow` databases. Tests run against the real test
  database and refuse to wipe any database whose name does not end in `_test`.
- **Rationale:** Real MySQL catches constraint and transaction behaviour that mocks would hide.

## 2026-10-28 — Prisma timing

- **Choice:** Prisma and MySQL are added in Milestone 1, not Milestone 0.
- **Rationale:** No models exist yet; adding an empty schema gives no value.
