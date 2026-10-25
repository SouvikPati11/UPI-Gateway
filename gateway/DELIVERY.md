# YOUPI PG — Complete Delivery Report

Date: 2026-10-25 (IST). Branch: `feature/cpanel-mysql-gateway`, created from
`main` at `90eecd5`. Main is untouched. Nothing in this delivery has been
pushed, merged, deployed to production, or used to process real money.

## What was delivered

A complete, deployable multi-merchant UPI payment gateway in `gateway/`
only. No existing application file outside `gateway/` was deleted or
replaced. The full feature list is in `README.md`; the API, SDK and webhook
documentation is in `docs/API.md`; the Hostinger / cPanel deployment guide
is in `docs/DEPLOYMENT.md`.

Routes delivered (all connected to the database, not placeholder pages):

- Public: `/`, `/health`, `/ready`, `/install`, `/install/diagnostics`,
  `/checkout/:ref` (+ `/paid`, `/sandbox-simulate`, `/cancel`),
  `/api/public/orders/:ref/status`, `/public/sdk.js`, `/public/css/style.css`.
- Merchant: `/merchant/register`, `/merchant/login`, `/merchant/logout`,
  `/merchant/dashboard`, `/merchant/orders`, `/merchant/orders/:ref`,
  `/merchant/profile`, `/merchant/api-keys` (+ revoke / rotate),
  `/merchant/webhooks` (+ secret generation / retry), `/merchant/docs`.
- Admin: `/admin/login`, `/admin/logout`, `/admin/dashboard`,
  `/admin/merchants`, `/admin/merchants/:id` (+ approve / suspend / reactivate),
  `/admin/orders`, `/admin/orders/:ref`, `/admin/verify` (+ success / fail),
  `/admin/webhooks`, `/admin/audit`, `/admin/settings`.
- Merchant API: `POST /api/v1/orders`, `GET /api/v1/orders/:ref`.
- Verification ingestion: `POST /api/v1/observers/events`,
  `POST /api/v1/provider/webhook` (raw-body HMAC, disabled with `501`
  until `PROVIDER_WEBHOOK_SECRET` is set).
- Cron: `POST /cron/webhooks`, `POST /cron/expire` (protected by
  `CRON_SECRET` when set; `503` disabled otherwise).

## Test results (exact, from this environment)

Environment for the test run: Node v24.22.1, npm 10.9.4, MariaDB
10.11.14 installed locally in the sandbox for this task (the sandbox
previously had no MySQL server or client). The test database was a
disposable database (`youpi_gateway_test` with a test-only user), created
and dropped by the test setup. No production database was used.

- **Full gateway suite: 32 passed, 0 failed, 0 skipped**
  (`npm test` with `GATEWAY_TEST_MYSQL=1` and disposable `DB_*` variables).
  This includes 21 unit/logic tests (config validation, UPI URI building,
  order transitions, migration-file sanity, HTTP skeleton, verification-event
  validation) and 11 live integration tests (installer + locking, merchant
  registration / pending status, admin approval, API key creation + CSRF,
  API order creation, checkout QR + UPI URI, "I have paid" → `processing`
  (never `success`), FIFO queue, manual verification + valid HMAC webhook,
  duplicate-UTR rejection, merchant isolation, observer fingerprint
  deduplication, sandbox success + live-simulate block, API key revocation,
  HTML escaping).
- **Migration test (real MariaDB, not claimed from a file read):**
  `npm run migrate:status` → `001_init: pending`, `002_order_mode_expiry: pending`,
  `003_order_seq: pending`; `npm run migrate` → all three `applied`;
  second `npm run migrate:status` → all three `already_applied`;
  `SHOW TABLES` → 12 tables (11 Stage 1 tables + `schema_migrations`).
- **Bugs found and fixed by these tests (not hidden):**
  1. UTC date parsing: MySQL DATETIME strings parsed as local time made
     orders look expired immediately on a non-UTC host. Fixed by parsing
     database dates as UTC (`parseDbDateUtc` in `validate.js`).
  2. FIFO queue ordering: `created_at` is only second-precision, so two
     orders created in the same second could not be ordered. Fixed with
     migration `003_order_seq` (unique auto-increment sequence) and a
     queue query on `seq`.
  3. Test cookie handling: Node's `fetch` does not expose `Set-Cookie`
     via `headers.get()` and follows login redirects, losing the session
     cookie. Fixed in the test helper only (use `getSetCookie()` and
     `redirect: 'manual'` for logins); the application code was not changed
     for this.
- **Baseline existing suite (original project, re-checked for this delivery):**
  unchanged from the Stage 1 report — suites 1–29 passed, suite 30
  (WhatsApp Berry auth, `apps/payment-api/src/__tests__/whatsapp-berry-auth.test.js`)
  failed pre-existing (pairing-code API returned 500 instead of 200), and
  suites 31–36 were not run because the runner stops at the first failure.
  That module was **not** modified in this delivery.
- **Not tested (honest gaps):**
  - A real MySQL 8.0 server (tested on MariaDB 10.11.14 only; MySQL 8.0
    compatibility is by SQL standard, not by a live MySQL 8 run).
  - A real provider API / webhook (no provider is configured; the endpoint
    is disabled by default and returns `501`).
  - A real Android SMS / Gmail observer (optional, external, not bundled).
  - Real UPI payments with real money (never attempted).
  - On-device mobile UPI app deep-link behaviour (deep links use the
    standard `upi://pay` URI; app-specific behaviour depends on the user's
    installed UPI apps).
  - The Hostinger / cPanel panel itself (no Hostinger account was used;
    the deployment guide is written from the cPanel Node.js App model and
    must be followed step by step on the host).

## Preserved, changed and unsupported features

### Preserved (from the original YOUPI project, adapted to Express + MySQL)

- YOUPI branding and reusable branding fields.
- UPI URI builder (`upi://pay?pa=&pn=&am=&cu=INR&tn=`), integer-paise money
  handling (no floating point), and the order state machine (with the
  explicit rule that there is no `pending → success` shortcut).
- FIFO queue logic (one active payment per merchant UPI ID), now with a
  monotonic sequence to make ordering reliable.
- Signed webhooks (HMAC-SHA256 over the raw body, timestamp, delivery id),
  delivery logs, backoff retries (5s / 30s / 2m / 10m / 1h), and
  observation fingerprint deduplication.
- The checkout SDK concept (`youpi.js` / `data-youpi-pay` in the original),
  now as `public/sdk.js` with `YoupiCheckout.open(checkoutUrl)` and a
  declarative `data-youpi-checkout-url` button. Secret keys are never used
  in the browser; the SDK only opens a checkout URL created server-side.

### Changed (necessarily, for cPanel)

- 8 hand-rolled `node:http` services on 8 ports → 1 Express app on
  `process.env.PORT`.
- SQLite (`node:sqlite`) → MySQL / MariaDB via `mysql2`, with versioned
  migrations (`001_init`, `002_order_mode_expiry`, `003_order_seq`).
- Single shared admin bearer token → per-admin accounts with scrypt
  password hashes, created by the installer (no hardcoded password).
- Merchant webhook secret doubling as a merchant key → separate public /
  secret API keys (secret stored only as prefix + hash, shown once) and a
  separate AES-256-GCM-encrypted webhook secret.
- No sessions / CSRF / rate limiting in the original → HttpOnly /
  Secure / SameSite session cookies, HMAC CSRF tokens for authenticated
  browser forms, and per-route rate limiting.
- No merchant password / status in the original → `password_hash` and
  `pending` / `approved` / `suspended` statuses with admin approval.

### Unsupported / optional (not silently removed — documented here)

- **WhatsApp OTP, Android SMS observer, Gmail observer, COD:** optional
  and external only. They are not required for the core gateway, are not
  started by this app, and are not bundled as mandatory services. The
  observer interface (`POST /api/v1/observers/events`) is the documented
  integration point if you later connect one.
- **Automatic bank verification for every merchant:** not promised and
  not implemented by default. Without a configured provider or observer,
  orders stay pending until manual reconciliation. This is a deliberate
  safety rule, not a missing feature to be worked around with screenshots
  or customer confirmations.
- **Original 8-service deployment, Docker, Redis, PostgreSQL, headless
  Chrome:** not supported in the cPanel app, by design (see README.md for
  the exact hosting requirements).
- **Upstream licence:** the original repository has no LICENSE file in its
  root despite its README pointing to one. Resolve upstream branding /
  rights before redistributing a ZIP publicly; this delivery does not
  claim ownership of the original project.

## Security notes

- Parameterised SQL queries only (no string-built queries with user input,
  except for the fixed table-name list in the installer's row-count check,
  which uses a hardcoded allow-list).
- Merchant-level authorisation on every merchant route and API route:
  queries are scoped by `merchant_id`, and cross-merchant access returns
  `404` (not the other merchant's data).
- Passwords: scrypt with random salt. API secrets: SHA-256 hash only.
  Webhook secrets: AES-256-GCM with `ENCRYPTION_MASTER_KEY` (64 hex chars).
  Sessions: only the SHA-256 hash of the token is stored; the plain token
  lives in an HttpOnly cookie.
- Production config validation refuses to boot with placeholder secrets,
  placeholder base URL, or missing database variables.
- Error responses never include stack traces or secrets. The installer
  never drops or erases data, and it locks after first use.
- **No real credentials are in this delivery.** `.env.example` contains
  placeholders only. The test database password used in the sandbox was a
  test-only password for a disposable database, is not in any committed
  file (the installer test deletes the `gateway/.env` it creates), and
  must never be reused for production.

## Deployment ZIP

Built for this delivery and attached with the final report:
`~/workspace/youpi-gateway-v1.0.0.zip` (92 KB, 44 files, `gateway/` only).
Verified after building: it contains no `.env` file and no `node_modules`
(you run `npm install --omit=dev` on the host). Rebuild it from the branch
after any further changes with:

```bash
cd ~/workspace/paymentgateway-stage1
git status --short gateway/   # review what is included first
mkdir -p /tmp/youpi-gateway-zip
cp -r gateway /tmp/youpi-gateway-zip/
rm -rf /tmp/youpi-gateway-zip/gateway/node_modules /tmp/youpi-gateway-zip/gateway/.env
cd /tmp/youpi-gateway-zip && zip -r ~/workspace/youpi-gateway-v1.0.0.zip gateway
```

Then follow `gateway/docs/DEPLOYMENT.md` (path B) on the host, run
`npm install --omit=dev` there, and open `/install`.

## Git status for this delivery (not a commit)

- Branch: `feature/cpanel-mysql-gateway` (local only). `main` at `90eecd5`
  is untouched. Nothing has been pushed or merged.
- **Not committed, for a specific reason:** the sandbox still has no Git
  author identity configured, and the delivery rules say to commit only
  when the author identity is properly configured and the changes have
  been reviewed. Do not invent an identity. When you are ready, run (with
  your own name and email, in `~/workspace/paymentgateway-stage1`):
  ```
  git config user.name "Your Name"
  git config user.email "you@example.com"
  git add gateway/
  git status --short
  git commit -m "feat(gateway): complete multi-merchant UPI gateway for cPanel"
  ```
  Then review the commit before any push. Pushing or merging requires a
  separate explicit approval.

## Known limitations and provider-specific requirements

- Manual reconciliation is the default verification path. If you onboard
  merchants who expect automatic verification, you need a real provider
  contract, a tested provider webhook, or a tested external observer —
  none of which is included by default.
- Checkout expiry is 15 minutes. Webhook retries are capped at 5 attempts.
  The cron endpoints are disabled until `CRON_SECRET` is set.
- The app is single-process and in-memory for rate limiting. That is
  correct for a single cPanel Node app; it is not a multi-instance design.
- Mobile UPI deep links depend on the customer's installed UPI apps and
  on the device supporting `upi://pay` links. Desktop users should scan
  the QR code.
- Before processing real money: test the full sandbox flow, test a manual
  reconciliation end-to-end, confirm each merchant's UPI ID and bank
  arrangements, and confirm your legal / tax position for operating a
  payment gateway in your jurisdiction. This delivery is software, not
  legal or banking advice, and the original project itself describes
  itself as experimental and not bank- or NPCI-approved.
