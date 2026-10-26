# Stage 1 Report — cPanel MySQL Gateway Foundation

**Branch:** `feature/cpanel-mysql-gateway` (local only, NOT pushed)
**Base:** `main` at `90eecd5` — `main` untouched, no merge, no deploy, no real payments.
**Decisions applied:** YOUPI branding preserved; v1 verification = manual
reconciliation + optional external-observer interface; provider adapter is an
interface only, with no automatic bank verification claimed.

## Commit status — READ THIS BEFORE REVIEWING

**The Stage 1 files are staged on branch `feature/cpanel-mysql-gateway` but
NOT yet committed.** The local commit failed with "Author identity unknown"
— this sandbox has no git `user.name` / `user.email` configured, and no
identity was found in any other local repo. I did not invent an email
address for the user. To finish the commit, the user must supply the name
and email to use for local commits, or approve a specific identity.
Until then: `git status` shows the 22 new `gateway/` files staged (A),
`main` is untouched, and nothing has been pushed. This is the one open
blocker for closing Stage 1 cleanly; all code and tests below are complete.

## Changed files (all new, under `gateway/` — no existing app touched)

- `gateway/package.json`, `gateway/package-lock.json` — Express 4 + mysql2 only; Node >= 20.
- `gateway/.env.example` — placeholders only.
- `gateway/src/config.js` — env loading + production validation (rejects placeholder
  secrets, placeholder base URL, missing/placeholder DB settings, unknown verification mode).
- `gateway/src/server.js`, `gateway/src/index.js` — single Express app on `$PORT`;
  `/health` (no DB), `/ready` (DB ping, 503 when unavailable), `/`, 404 + generic errors.
- `gateway/src/db/pool.js` — lazy mysql2 pool, parameterised queries only, `multipleStatements: false`.
- `gateway/src/db/migrate.js` — versioned runner (`schema_migrations` table) + CLI
  (`npm run migrate`, `npm run migrate:status`).
- `gateway/migrations/001_init.sql` — 11 tables: admins, merchants (password_hash,
  status pending/approved/suspended, upi_id, webhook_secret_encrypted, branding),
  receiving_accounts, merchant_api_keys (prefix + hash, public/secret), sessions
  (token_hash), orders (integer paise, gateway_reference unique, merchant_order unique
  per merchant, verification_source), order_events, verification_events
  (fingerprint_hash unique for duplicate detection), webhook_deliveries,
  audit_logs, app_settings. No rows seeded.
- `gateway/src/upi.js`, `gateway/src/state-machine.js` — pure UPI URI builder
  (paise, no floats) and order transition table (pending -> processing -> success
  -> refunded-recorded; no pending -> success shortcut).
- `gateway/src/verification/adapter.js` — v1 interface + event validator;
  `verify()` throws "not implemented in Stage 1" by design.
- `gateway/tests/*.test.js` (7 files) — config, UPI, state machine, verification
  validator, migrations, HTTP skeleton, live-MySQL skip test.
- `gateway/README.md`, `gateway/docs/VERIFICATION.md` — hosting prerequisites
  (Node >= 20, MySQL 8 / MariaDB 10.5+, one Node app, one PORT, env in App panel,
  app folder outside public_html), install steps, and verification rules.

## Commands run and actual results

- Baseline (existing repo, before branching, Node 24.22.1):
  `npm install` OK (159 packages); `npm test` FAILED at suite 30/36.
  Suites 1–29 passed. Suite 30 `apps/payment-api/src/__tests__/whatsapp-berry-auth.test.js`
  failed (node test summary: 11 pass / 2 fail in that file; the named failure is
  test 11, pairing-code API returned 500 instead of 200, with a WhatsApp WebSocket
  TLS error in the log). Suites 31–36 were NOT run because the runner exits on
  first failure. This is a pre-existing failure in the optional WhatsApp module,
  unrelated to Stage 1, and was NOT fixed in Stage 1 (out of scope).
- New gateway: `cd gateway && npm install` OK (79 packages); `npm test`:
  **21 passed, 0 failed, 1 skipped** (22 total). The skipped test is the live
  MySQL test (`GATEWAY_TEST_MYSQL` unset) — reported as skipped, not passed.
- Production-config smoke test: with placeholder secrets, `node src/index.js`
  threw "Production configuration invalid" before listening (SESSION_SECRET,
  ENCRYPTION_MASTER_KEY, APP_BASE_URL, DB_PASSWORD flagged).
- Dev smoke test: `PORT=3456 npm start` served `/health` 200
  (`database: not_configured`) and `/ready` 503, as designed.

## NOT run / unresolved (do not treat as passed)

- **No live MySQL test, no migration execution against MySQL.** This sandbox has
  no MySQL server or client (`mysql: command not found`). Migration SQL was
  checked by reading + by the migration-file tests (tables, MySQL vs PostgreSQL
  syntax markers, statement splitting) only. `npm run migrate` against a real
  MySQL 8 / MariaDB 10.5+ database on the host is a required acceptance step
  before Stage 2.
- **No checkout, merchant login, admin panel, webhook delivery, or payment
  success path exists yet.** That is Stage 1 scope, not a bug — but it means
  this build must not be presented as a working gateway yet.
- Baseline WhatsApp suite failure (above) remains open and unaddressed.

## Exact next steps for Stage 2 (NOT started)

1. Review this report and approve Stage 2 (or request changes).
2. On the host, create the cPanel MySQL database and run `npm run migrate`
   to prove 001_init applies cleanly; report the result.
3. Stage 2 work (after approval): merchant registration/login with hashed
   passwords + HttpOnly session cookies + CSRF, admin approval/suspension,
   merchant profile + UPI ID, API key issue/rotate/revoke (show secret once),
   merchant-isolation tests, and the admin panel foundations.
