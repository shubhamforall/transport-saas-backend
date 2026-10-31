# transport-saas-backend

REST API for **Vaharo**, a multi-tenant transport management SaaS for Indian goods-transport businesses.

Frontend lives in a separate repository: `transport-saas-frontend`.

## Stack

Node.js 20+ · Express 5 · TypeScript (strict) · Zod · Prisma 7 + MySQL 8 · Pino · Vitest + Supertest.

## Getting started

### 1. Database (local MySQL in Docker)

```bash
docker run -d --name vaharo-mysql -p 3307:3306 \
  -e MYSQL_ROOT_PASSWORD=<root-password> \
  -v vaharo_mysql_data:/var/lib/mysql mysql:8.4
```

Then create three databases and a user (run inside `docker exec -it vaharo-mysql mysql -uroot -p`):

```sql
CREATE DATABASE vaharo;  CREATE DATABASE vaharo_test;  CREATE DATABASE vaharo_shadow;
CREATE USER 'vaharo'@'%' IDENTIFIED BY '<app-password>';
GRANT ALL PRIVILEGES ON vaharo.* TO 'vaharo'@'%';
GRANT ALL PRIVILEGES ON vaharo_test.* TO 'vaharo'@'%';
GRANT ALL PRIVILEGES ON vaharo_shadow.* TO 'vaharo'@'%';
```

After a reboot, start it again with `docker start vaharo-mysql`.

### 2. API

```bash
cp .env.example .env    # then fill in DATABASE_URL, TEST_DATABASE_URL, JWT_ACCESS_SECRET
npm install             # also generates the Prisma client
npm run db:migrate      # apply migrations to the dev database
npm run db:seed         # optional: sample companies and users (dev only)
npm run dev             # http://localhost:4000
```

Check it is running: `GET http://localhost:4000/health`.

Sample sign-ins after seeding (password `Vaharo@Demo123` or `SEED_DEMO_PASSWORD`):
`owner@demo.vaharo.local` and `owner2@demo.vaharo.local` (company owners) and
`admin@demo.vaharo.local` (Super Admin). Sample data is labelled "(Sample)" and never seeded in production.

Without SMTP settings, emails (invoices, invitations, password resets) are saved as `.eml` files in
`tmp/outbox/` so you can open them locally.

## Scripts

| Script                              | Purpose                                        |
| ----------------------------------- | ---------------------------------------------- |
| `npm run dev`                       | Start with auto-reload                         |
| `npm run build`                     | Compile to `dist/`                             |
| `npm start`                         | Run the compiled build                         |
| `npm run lint`                      | ESLint                                         |
| `npm run typecheck`                 | TypeScript without emitting                    |
| `npm run format:check`              | Prettier check                                 |
| `npm test`                          | Run tests (uses `TEST_DATABASE_URL`, wipes it) |
| `npm run db:migrate`                | Create/apply migrations in development         |
| `npm run db:deploy`                 | Apply migrations (production/CI)               |
| `npm run db:seed`                   | Load sample data (refuses in production)       |
| `npm run db:studio`                 | Browse the database                            |
| `npm run platform:admin -- <email>` | Grant Super Admin to an existing user          |

## Project layout

```text
src/
  app.ts            Express app factory (middleware, routes, error handling)
  server.ts         Process entry point
  config/           Environment validation
  middleware/       Request ID, CSRF, auth, tenant membership, error handling
  modules/          One folder per feature: auth, tenants, customers, vehicles, jobs, invoices,
                    payments, reports, team, subscriptions, platform (Super Admin)
  pdf/              Invoice PDF rendering (bundled DejaVu font for the ₹ sign)
  scripts/          Server-side CLI tasks
  services/         Prisma client, permissions, audit log, mailer, sequences, subscriptions, Razorpay
  utils/            Logger, AppError, crypto helpers
  generated/        Prisma client (generated, not committed)
prisma/
  schema.prisma     Database schema
  migrations/       SQL migrations (committed)
  seed.ts           Development sample data
tests/              Vitest + Supertest tests (run against a real MySQL test database)
docs/               API contract, decisions, deployment notes
scripts/backup-db.sh  Daily MySQL backup (see docs/DEPLOYMENT.md)
assets/fonts/       Fonts embedded in PDFs
```

## API conventions

- Base path: `/api/v1`.
- Auth uses HttpOnly cookies. State-changing requests need the `X-CSRF-Token` header (see
  [docs/API.md](docs/API.md)).
- Tenant routes are `/tenants/:tenantId/...`; access is checked against the user's membership on
  every request.
- Errors always use this shape and never include stack traces:

```json
{ "error": { "code": "NOT_FOUND", "message": "...", "fieldErrors": {}, "requestId": "..." } }
```

- Every response carries an `X-Request-Id` header for support and log correlation.

See [docs/API.md](docs/API.md), [docs/DECISIONS.md](docs/DECISIONS.md) and [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md).
