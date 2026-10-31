# Vaharo API

Base path: `/api/v1`. All request and response bodies are JSON.

> This file is the API contract shared with `transport-saas-frontend`. Update it in the same
> change as any endpoint. An OpenAPI spec may replace it later.

## Conventions

- **Auth:** HttpOnly cookies. The frontend must send every request with
  `credentials: 'include'`.
  - `vaharo_at`: access token (JWT, 15 minutes by default), sent to the whole API.
  - `vaharo_rt`: refresh token (30 days by default), sent only to `/api/v1/auth/*`. Rotated on
    every refresh; reusing an old one signs out every session in that login family.
- **CSRF:** every `POST`/`PATCH`/`PUT`/`DELETE` needs header `X-CSRF-Token` matching the
  HttpOnly `vaharo_csrf` cookie. Get both from `GET /auth/csrf` and keep the token in memory.
  A `403 CSRF_INVALID` means: fetch a new token and retry once.
- **Expired access token:** a `401` on any endpoint means: call `POST /auth/refresh` once, then
  retry. If refresh also returns `401`, the user must sign in again.
- **Tenant routes:** `/tenants/:tenantId/...`. The `tenantId` is a selector only; the server
  checks membership and role on every request. A company the user cannot access returns `404`
  (never `403`), so company ids cannot be probed.
- **Money:** integer paise in fields ending `Minor` (e.g. `grandTotalMinor: 1200000` = ₹12,000.00).
- **Dates:** ISO 8601 strings, stored in UTC.

### Error shape

```json
{
  "error": {
    "code": "BAD_REQUEST",
    "message": "Validation failed",
    "fieldErrors": { "email": ["Invalid email"] },
    "requestId": "c0a8..."
  }
}
```

| Status | `code`                                                   |
| ------ | -------------------------------------------------------- |
| 400    | `BAD_REQUEST`                                            |
| 401    | `UNAUTHORIZED`, `INVALID_CREDENTIALS`, `SESSION_EXPIRED` |
| 403    | `FORBIDDEN`, `CSRF_INVALID`, `TENANT_SUSPENDED`          |
| 404    | `NOT_FOUND`                                              |
| 409    | `CONFLICT`, `EMAIL_TAKEN`, `TENANT_LIMIT`                |
| 413    | `PAYLOAD_TOO_LARGE`                                      |
| 429    | `TOO_MANY_REQUESTS`                                      |
| 500    | `INTERNAL_ERROR`                                         |

### Roles and permissions

Roles: `OWNER`, `ADMIN`, `OPERATIONS`, `ACCOUNTS`, `VIEWER`. Responses include the caller's
`permissions` so the UI can hide actions; the server enforces them regardless.

| Permission        | Owner | Admin | Operations | Accounts | Viewer |
| ----------------- | :---: | :---: | :--------: | :------: | :----: |
| `tenant.read`     |   ✓   |   ✓   |     ✓      |    ✓     |   ✓    |
| `tenant.update`   |   ✓   |   ✓   |            |          |        |
| `members.read`    |   ✓   |   ✓   |     ✓      |    ✓     |        |
| `members.manage`  |   ✓   |   ✓   |            |          |        |
| `billing.manage`  |   ✓   |       |            |          |        |
| `customers.read`  |   ✓   |   ✓   |     ✓      |    ✓     |   ✓    |
| `customers.write` |   ✓   |   ✓   |     ✓      |          |        |
| `vehicles.read`   |   ✓   |   ✓   |     ✓      |    ✓     |   ✓    |
| `vehicles.write`  |   ✓   |   ✓   |     ✓      |          |        |
| `jobs.read`       |   ✓   |   ✓   |     ✓      |    ✓     |   ✓    |
| `jobs.write`      |   ✓   |   ✓   |     ✓      |          |        |
| `invoices.read`   |   ✓   |   ✓   |     ✓      |    ✓     |   ✓    |
| `invoices.write`  |   ✓   |   ✓   |            |    ✓     |        |
| `payments.read`   |   ✓   |   ✓   |            |    ✓     |   ✓    |
| `payments.write`  |   ✓   |   ✓   |            |    ✓     |        |
| `reports.read`    |   ✓   |   ✓   |     ✓      |    ✓     |   ✓    |

## Endpoints

### Health

`GET /health` and `GET /api/v1/health`

```json
{ "status": "ok", "service": "vaharo-api", "time": "2026-10-28T10:00:00.000Z" }
```

### Auth

Login, register and refresh are rate-limited per IP (default 20 per 15 minutes).

#### `GET /auth/csrf`

Sets the `vaharo_csrf` cookie and returns `{ "csrfToken": "..." }`.

#### `POST /auth/register` → `201`

```json
{ "name": "Asha Patil", "email": "asha@example.com", "password": "at-least-8-chars" }
```

Email is trimmed and lower-cased. Password: 8+ characters, at most 72 bytes. Signs the user in
(sets cookies) and returns the same body as `GET /auth/me`. Duplicate email → `409 EMAIL_TAKEN`.

#### `POST /auth/login` → `200`

`{ "email": "...", "password": "..." }`. Wrong email and wrong password return the same
`401 INVALID_CREDENTIALS`. Returns the `GET /auth/me` body.

#### `POST /auth/refresh` → `204`

Uses the `vaharo_rt` cookie; issues new access and refresh cookies. `401 SESSION_EXPIRED` when
the refresh token is missing, expired, revoked or reused.

#### `POST /auth/logout` → `204`

Revokes the refresh token and clears cookies. Works even if the access token has expired.

#### `GET /auth/me` → `200`

```json
{
  "user": {
    "id": "c…",
    "name": "Asha Patil",
    "email": "asha@example.com",
    "isPlatformAdmin": false
  },
  "memberships": [
    {
      "membershipId": "c…",
      "tenantId": "c…",
      "tenantName": "Patil Transport Co.",
      "role": "OWNER",
      "permissions": ["tenant.read", "tenant.update", "..."]
    }
  ]
}
```

Only active memberships in active companies are listed.

### Companies (tenants)

All require sign-in.

#### Tenant object

```json
{
  "id": "c…",
  "name": "Patil Transport Co.",
  "legalName": null,
  "phone": "+919876543210",
  "email": null,
  "addressLine1": null,
  "addressLine2": null,
  "city": "Pune",
  "state": "Maharashtra",
  "postalCode": "411001",
  "country": "IN",
  "gstin": "27ABCDE1234F1Z5",
  "stateCode": "27",
  "currency": "INR",
  "timezone": "Asia/Kolkata",
  "status": "ACTIVE",
  "createdAt": "…",
  "updatedAt": "…",
  "myRole": "OWNER",
  "myPermissions": ["…"]
}
```

#### `POST /tenants` → `201`

Creates a company and makes the caller its `OWNER` (one transaction, audited as
`tenant.created`). Body: `name` (required, 2–120) plus any of `legalName`, `phone`, `email`,
`addressLine1`, `addressLine2`, `city`, `state`, `postalCode` (6-digit PIN), `gstin`,
`stateCode` (2 digits). Empty strings are stored as `null`. Unknown fields → `400`.
GSTIN is upper-cased, format-checked, and must start with `stateCode` when both are set.
A user can own at most 5 companies → `409 TENANT_LIMIT`.

#### `GET /tenants` → `200`

`{ "items": [Tenant, ...] }`: only companies the caller belongs to.

#### `GET /tenants/:tenantId` → `200`

Needs `tenant.read`.

#### `PATCH /tenants/:tenantId` → `200`

Needs `tenant.update` (Owner, Admin). Same fields as create, all optional. Audited as
`tenant.updated` (field names only, not values).

### Common list parameters

List endpoints accept `page` (default 1), `pageSize` (1-100, default 20), `q` (search text),
`sort` (per-endpoint allowlist; anything else is `400`) and `order` (`asc` | `desc`). They return:

```json
{ "items": [], "page": 1, "pageSize": 20, "total": 0, "totalPages": 1 }
```

Dates are `YYYY-MM-DD` (calendar dates in the company's time zone, Asia/Kolkata by default).
Quantities and capacities are integers in thousandths (`quantityMilli: 2500` = 2.5).
GST rates are basis points (`taxRateBps: 1800` = 18%).

### Company settings (additional `PATCH /tenants/:tenantId` fields)

`jobNumberPrefix` (1-10 of A-Z 0-9 / -), `invoicePrefix` (1-5 of A-Z 0-9), `defaultPaymentTermsDays`
(0-365), `defaultTaxRateBps` (0-10000), `defaultSacCode` (4-8 digits), `invoiceTerms`,
`paymentInstructions`. Invoice numbers look like `INV/26-27/0001` (restart each 1 April, max 16
characters).

### Customers (`customers.read` / `customers.write`)

| Method | Path                                                      | Notes                                                                                                                                                                                                        |
| ------ | --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| GET    | `/tenants/:id/customers`                                  | `status=ACTIVE\|ARCHIVED\|ALL` (default ACTIVE); `q` matches name, email, phone, GSTIN, contact; `sort=name\|createdAt`                                                                                      |
| POST   | `/tenants/:id/customers`                                  | `customerType` (BUSINESS\|INDIVIDUAL), `name`*, `contactPerson`, `email`, `phone`, `addressLine1/2`, `city`, `state`, `stateCode`, `postalCode`, `gstin` (must match stateCode), `paymentTermsDays`, `notes` |
| GET    | `/tenants/:id/customers/:customerId`                      | includes `jobCount`, `invoiceCount`                                                                                                                                                                          |
| PATCH  | `/tenants/:id/customers/:customerId`                      | any create field                                                                                                                                                                                             |
| POST   | `/tenants/:id/customers/:customerId/archive` · `/restore` | no hard delete; archived customers cannot be used on new jobs/invoices                                                                                                                                       |

### Vehicles (`vehicles.read` / `vehicles.write`)

| Method      | Path                                                        | Notes                                                                                                                                                                                                                                                                                                                                                                                                                   |
| ----------- | ----------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| GET         | `/tenants/:id/vehicles`                                     | `status=ACTIVE\|INACTIVE\|ALL`, `vehicleType`, `q` (registration, model); `sort=registration\|createdAt`                                                                                                                                                                                                                                                                                                                |
| POST        | `/tenants/:id/vehicles`                                     | `registrationNumber`_, `vehicleType`_ (MINI_TRUCK, LCV, MEDIUM_TRUCK, HEAVY_TRUCK, TRAILER, CONTAINER_TRUCK, PICKUP, OTHER), `makeModel`, `capacityMilli`, `capacityUnit` (TONNES\|KG\|CUBIC_METRES), `ownershipType` (OWNED\|LEASED\|ATTACHED\|OTHER), `notes`. Registration is normalised (upper-case, no spaces) and unique per company → `409` with `fieldErrors.registrationNumber`. Plan limit → `409 PLAN_LIMIT` |
| GET / PATCH | `/tenants/:id/vehicles/:vehicleId`                          |                                                                                                                                                                                                                                                                                                                                                                                                                         |
| POST        | `/tenants/:id/vehicles/:vehicleId/deactivate` · `/activate` |                                                                                                                                                                                                                                                                                                                                                                                                                         |

### Transport jobs (`jobs.read` / `jobs.write`)

| Method | Path                                     | Notes                                                                                                                                                                                                                                                                                                                                                                                                                               |
| ------ | ---------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| GET    | `/tenants/:id/jobs`                      | filters: `status` (comma list), `customerId`, `vehicleId`, `bookingFrom/To`, `deliveryFrom/To`, `invoiced=yes\|no`, `q` (job no., LR, cities, customer, registration); `sort=bookingDate\|createdAt\|jobNumber`                                                                                                                                                                                                                     |
| GET    | `/tenants/:id/jobs/eligible-for-invoice` | `invoices.read`; delivered jobs not on any invoice; optional `customerId`                                                                                                                                                                                                                                                                                                                                                           |
| POST   | `/tenants/:id/jobs`                      | `customerId`_, `vehicleId`, `bookingDate`_, `originCity`_, `destinationCity`_, addresses, planned/actual pickup & delivery dates, `driverName`, `driverPhone`, `goodsDescription`_, `quantityMilli`, `quantityUnit`, `lrNumber`, `freightAmountMinor`_, `discountAmountMinor`, `taxRateBps`, `internalNotes`, `charges[]` ({`description`, `amountMinor`}), `status` (DRAFT\|BOOKED). Job number assigned by the server per company |
| GET    | `/tenants/:id/jobs/:jobId`               | adds `statusHistory`, `allowedTransitions`, `invoiceState` (NOT_INVOICED\|IN_DRAFT\|INVOICED), `totalMinor`                                                                                                                                                                                                                                                                                                                         |
| PATCH  | `/tenants/:id/jobs/:jobId`               | not allowed once on an invoice (`409 JOB_INVOICED`) or cancelled                                                                                                                                                                                                                                                                                                                                                                    |
| POST   | `/tenants/:id/jobs/:jobId/status`        | `{ status, note?, date? }`. Allowed: DRAFT→BOOKED/CANCELLED; BOOKED→IN_TRANSIT/DELIVERED/DRAFT/CANCELLED; IN_TRANSIT→DELIVERED/BOOKED/CANCELLED; DELIVERED→IN_TRANSIT (only while not invoiced). Others → `409 INVALID_TRANSITION`. Records pickup/delivery dates                                                                                                                                                                   |

### Invoices (`invoices.read` / `invoices.write`)

| Method | Path                                          | Notes                                                                                                                                                                                                                                                                                                                                                                                   |
| ------ | --------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| GET    | `/tenants/:id/invoices`                       | `status` (comma list of DRAFT, ISSUED, PARTIALLY_PAID, PAID, CANCELLED, OVERDUE), `customerId`, `from`, `to`, `q` (number, customer); `sort=invoiceDate\|createdAt\|grandTotal\|dueDate`                                                                                                                                                                                                |
| POST   | `/tenants/:id/invoices`                       | Creates a **draft**. `jobIds[]` (delivered, unbilled, same customer; lines are prefilled) or `customerId` (manual). Optional `invoiceDate`, `dueDate` (default: date + customer/company terms), `taxType` (NONE\|INTRA_STATE\|INTER_STATE; suggested from states), `placeOfSupplyStateCode`, `items[]`, `notes`, `terms`. A job already on another invoice → `409 JOB_ALREADY_INVOICED` |
| GET    | `/tenants/:id/invoices/:invoiceId`            | full invoice: `billTo`/`from` (frozen at issue), `items`, `jobs`, `payments`, totals, `balanceMinor`, `displayStatus` (adds OVERDUE)                                                                                                                                                                                                                                                    |
| PATCH  | `/tenants/:id/invoices/:invoiceId`            | drafts only (`409 INVOICE_NOT_DRAFT`). `items[]`: `description`, `sacCode`, `quantityMilli`, `unitPriceMinor`, `discountMinor`, `taxRateBps`. The server computes every total                                                                                                                                                                                                           |
| DELETE | `/tenants/:id/invoices/:invoiceId`            | drafts only; linked jobs become billable again                                                                                                                                                                                                                                                                                                                                          |
| POST   | `/tenants/:id/invoices/:invoiceId/issue`      | validates company/customer details (`400 INVOICE_INCOMPLETE` with `fieldErrors`), recalculates, assigns the number, freezes details. Repeating the call returns the issued invoice (no second number)                                                                                                                                                                                   |
| POST   | `/tenants/:id/invoices/:invoiceId/cancel`     | `{ reason }`; only ISSUED without payments (`409 HAS_PAYMENTS`); jobs are released; number is never reused                                                                                                                                                                                                                                                                              |
| GET    | `/tenants/:id/invoices/:invoiceId/pdf`        | `application/pdf` from saved data (drafts watermarked). Rate-limited                                                                                                                                                                                                                                                                                                                    |
| POST   | `/tenants/:id/invoices/:invoiceId/email`      | `{ to?, cc?, message? }`; issued invoices only; PDF attached; returns the email log. `409 EMAIL_IN_PROGRESS` on double click; `502 EMAIL_FAILED` with a safe message                                                                                                                                                                                                                    |
| GET    | `/tenants/:id/invoices/:invoiceId/email-logs` | delivery attempts                                                                                                                                                                                                                                                                                                                                                                       |

### Payments (`payments.read` / `payments.write`)

| Method | Path                                    | Notes                                                                                                                                                                                                        |
| ------ | --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| GET    | `/tenants/:id/payments`                 | `status=RECORDED\|VOIDED\|ALL`, `customerId`, `invoiceId`, `method`, `from`, `to`, `q`                                                                                                                       |
| POST   | `/tenants/:id/payments`                 | `{ invoiceId, paymentDate, amountMinor, method (CASH\|BANK_TRANSFER\|UPI\|CHEQUE\|OTHER), reference?, notes? }`. More than the balance → `400 OVER_ALLOCATION`. Updates the invoice to PARTIALLY_PAID / PAID |
| GET    | `/tenants/:id/payments/:paymentId`      |                                                                                                                                                                                                              |
| POST   | `/tenants/:id/payments/:paymentId/void` | `{ reason }`; restores the invoice balance                                                                                                                                                                   |

### Dashboard and reports

| Method | Path                                    | Permission     | Notes                                                                                                                                     |
| ------ | --------------------------------------- | -------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| GET    | `/tenants/:id/dashboard`                | `tenant.read`  | active / in-transit / delivered-not-invoiced jobs, invoices this month, outstanding, overdue, received this month, recent jobs & invoices |
| GET    | `/tenants/:id/reports/receivables`      | `reports.read` | outstanding per customer with ageing buckets                                                                                              |
| GET    | `/tenants/:id/reports/jobs?from&to`     | `reports.read` | by status, by month, top routes, vehicle usage                                                                                            |
| GET    | `/tenants/:id/reports/invoices?from&to` | `reports.read` | by month with CGST/SGST/IGST, top customers                                                                                               |

Definitions follow project plan section 17 (e.g. received this month = valid payment allocations
dated this month).

### Team (`members.read` / `members.manage`)

| Method | Path                                            | Notes                                                                                                                                                                                                 |
| ------ | ----------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| GET    | `/tenants/:id/members`                          | members; pending invitations only for managers                                                                                                                                                        |
| POST   | `/tenants/:id/invitations`                      | `{ email, role }`; you can only invite roles below your own (Owner → Admin and below; Admin → Operations/Accounts/Viewer). Emails a 7-day single-use link. Plan user limit counts pending invitations |
| POST   | `/tenants/:id/invitations/:invitationId/revoke` |                                                                                                                                                                                                       |
| PATCH  | `/tenants/:id/members/:membershipId/role`       | `{ role }`; same rank rule; never your own role; Owner only via transfer                                                                                                                              |
| DELETE | `/tenants/:id/members/:membershipId`            | soft remove; same rank rule (an Owner can never be removed)                                                                                                                                           |
| POST   | `/tenants/:id/transfer-ownership`               | Owner only; `{ membershipId, confirmCompanyName }`; old Owner becomes Admin                                                                                                                           |
| GET    | `/invitations/lookup?token=`                    | public: company, email, role, expired/accepted                                                                                                                                                        |
| POST   | `/invitations/accept`                           | signed in; `{ token }`; account email must match (`403 INVITATION_EMAIL_MISMATCH`)                                                                                                                    |

### Password reset

| Method | Path                    | Notes                                                                                                                      |
| ------ | ----------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| POST   | `/auth/forgot-password` | `{ email }` → always `202` with the same message; emails a 1-hour single-use link to `APP_BASE_URL/reset-password?token=…` |
| POST   | `/auth/reset-password`  | `{ token, password }` → `204`; signs out all sessions. Bad/expired/used link → `400 RESET_LINK_INVALID`                    |

### Plans and subscriptions

| Method | Path                                 | Permission       | Notes                                                                                                                            |
| ------ | ------------------------------------ | ---------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| GET    | `/plans`                             | public           | active plans: price, interval, `limits` ({maxUsers, maxVehicles}; missing = unlimited), features, `onlineCheckout`               |
| GET    | `/tenants/:id/subscription`          | `tenant.read`    | current subscription, `access` ({mode FULL\|READ_ONLY, reason}), usage vs limits, pending checkout                               |
| POST   | `/tenants/:id/subscription/checkout` | `billing.manage` | `{ planCode }` → Razorpay `subscriptionId` + `keyId` for Checkout.js. `503 BILLING_NOT_CONFIGURED` without keys                  |
| POST   | `/tenants/:id/subscription/cancel`   | `billing.manage` | Razorpay: cancels at period end; trial: ends at trial end                                                                        |
| POST   | `/billing/webhooks/razorpay`         | signature        | raw JSON; `X-Razorpay-Signature` (HMAC-SHA256) and `X-Razorpay-Event-Id` required; duplicates return `{ "result": "duplicate" }` |

**Access policy:** new companies get a `TRIAL` (`TRIAL_DAYS`) on the first active plan. When the
trial ends, a payment fails beyond `PAST_DUE_GRACE_DAYS`, or a cancelled period runs out, the
company becomes **read-only**: every non-GET request on company routes (except
`/subscription/*`) returns `402 SUBSCRIPTION_INACTIVE`. Nothing is deleted.

### Super Admin (`/platform/*`, platform administrators only; others get `404`)

`GET /platform/tenants` (search, status) · `GET /platform/tenants/:id` (metadata, members,
counts, subscription history, never business records) · `POST /platform/tenants/:id/status`
(`{ status: ACTIVE|SUSPENDED, reason }`) · `POST /platform/tenants/:id/subscription` (manual
subscription: `{ planId, status, until?, reason }`) · `GET|POST /platform/plans` ·
`PATCH /platform/plans/:planId` · `GET /platform/subscriptions` · `GET /platform/webhook-events` ·
`GET /platform/audit-logs` (`tenantId`, `action` prefix; details shown only for platform and
subscription actions). All changes are audited.

Error codes added in these modules: `402 SUBSCRIPTION_INACTIVE`, `409 PLAN_LIMIT`,
`409 JOB_INVOICED`, `409 INVALID_TRANSITION`, `409 JOB_ALREADY_INVOICED`,
`409 INVOICE_NOT_DRAFT`, `400 INVOICE_INCOMPLETE`, `409 HAS_PAYMENTS`, `400 OVER_ALLOCATION`,
`409 EMAIL_IN_PROGRESS`, `502 EMAIL_FAILED`, `409 ALREADY_MEMBER`, `400 INVITATION_INVALID`,
`503 BILLING_NOT_CONFIGURED`, `502 BILLING_PROVIDER_ERROR`, `400 INVALID_SIGNATURE`.
