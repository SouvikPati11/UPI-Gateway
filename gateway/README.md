# YOUPI PG — Multi-Merchant UPI Payment Gateway (cPanel)

A **single** Express + MySQL application for Hostinger / cPanel hosting.
This `gateway/` folder is self-contained: it does not depend on the original
multi-service apps in `apps/` or on SQLite, and it does not modify them.
The original apps remain untouched on this branch; they are not run by this
gateway.

> **Hostinger startup fix (v1.0.1):** if Hostinger reports "App did not
> call listen() within 3 seconds" / 503, use
> `youpi-gateway-hostinger-fixed.zip` (flat structure) and the exact
> settings in `docs/DEPLOYMENT.md` section 2A. Full root-cause report:
> `HOSTINGER_FIX.md`. In short: v1.0.0 died before `listen()` on any
> production config error and nested everything under `gateway/` in the
> ZIP; v1.0.1 listens promptly in degraded/setup mode with diagnostics
> when config is invalid, and ships as a flat ZIP.

What is implemented (complete, not a skeleton):

- **Merchant website:** registration, login, profile + UPI ID, pending /
  approved / suspended statuses, dashboard with statistics, order history
  with search, filters and pagination, order details, API key creation /
  rotation / revocation, webhook URL + secret management, webhook delivery
  logs with retry, and integration docs.
- **Admin panel:** admin login, merchant approval / rejection / suspension /
  reactivation, merchant search and details, order management, manual
  verification and reconciliation queue, application settings, webhook
  monitoring, audit logs and security events, verification configuration.
- **UPI checkout:** dynamic QR codes from the merchant's UPI ID and order
  amount, UPI app deep links, mobile-responsive pages, unique order IDs and
  gateway references, pending / processing / success / failed / expired /
  cancelled / recorded-refund states, a JavaScript SDK (`/public/sdk.js`),
  a merchant REST API, signed webhooks with retries and delivery history,
  duplicate-event prevention, idempotent order creation, and a sandbox mode
  clearly separated from real payments.
- **Verification:** manual reconciliation (default), an optional external-
  observer interface, a provider webhook interface (disabled until a real
  provider is configured and tested), and a sandbox-only simulator.
  A QR scan, redirect, screenshot or "I have paid" click **never** marks an
  order successful.
- **Installer:** a browser-based wizard at `/install` that tests the
  database connection, checks for existing data and requires confirmation
  before migrating, runs versioned migrations, creates the first
  administrator (no hardcoded password), and then locks itself.
- **Diagnostics:** `/health`, `/ready` and `/install/diagnostics`
  (no secrets in output), plus cron endpoints for expiry and webhook retries.

## Minimum requirements (do not deploy below these)

- **Node.js >= 20.0.0 LTS** (22 LTS recommended).
- **MySQL 8.0+ or MariaDB 10.5+**, with a database, user and password created
  in cPanel first. Migrations use InnoDB, `utf8mb4`, `JSON` and `CHECK`
  constraints.
- **One long-running Node.js application** (cPanel "Setup Node.js App"):
  one entry file (`src/index.js`), one port taken from `process.env.PORT`.
  The old 8-port topology (5000/6001/6002/6003/6100/7000/8090/3000) is
  **not** used and is **not** supported on shared hosting.
- **Environment variables set in the Node.js App panel**, not a `.env` file
  uploaded into a web-accessible folder. The app folder itself must live
  **outside `public_html`**.
- Optional: a **cPanel cron job** for expiry and webhook retries (also
  checked on checkout load and from the dashboard). No Docker, Redis,
  PostgreSQL, headless Chrome or always-on background worker is required.

**Explicitly unsupported:** PHP-only plans, Node < 20, plans without a
long-running Node process, plans without MySQL, and the original
multi-service / Chrome-CDP observer setup inside the cPanel app itself
(observers are optional and external — see `docs/API.md`).

## Install

Full numbered steps for Hostinger / cPanel are in
`docs/DEPLOYMENT.md`. Short version:

```bash
cd gateway
npm install --omit=dev        # production; use plain `npm install` for tests
# On cPanel, set environment variables in the Node.js App panel (see .env.example).
npm start                     # listens on $PORT (3000 locally)
curl http://localhost:3000/health   # {"status":"ok", ...}, no database needed
curl http://localhost:3000/ready    # 200 only when MySQL pings; 503 otherwise
```

Then open `/install` in a browser: it tests the database, runs migrations
(`001_init`, `002_order_mode_expiry`, `003_order_seq`), creates the first
administrator and locks itself. In production (`NODE_ENV=production`) the
app **refuses to boot** if `SESSION_SECRET` is a placeholder or shorter
than 32 characters, if `ENCRYPTION_MASTER_KEY` is not exactly 64 hex
characters, if `APP_BASE_URL` is a placeholder, or if any of
`DB_HOST / DB_USER / DB_PASSWORD / DB_NAME` is missing or a placeholder.
Generate secrets with:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

## Layout

```
gateway/
  .env.example            placeholders only (safe to commit)
  package.json            express + mysql2 + qrcode
  migrations/             001_init, 002_order_mode_expiry, 003_order_seq
  src/
    config.js             env loading + production validation
    app.js                full application: public, merchant, admin, API, checkout, installer, cron
    server.js             re-exports createApp from app.js (Stage 1 compatibility)
    index.js              boot (validates production config before listen)
    crypto.js             scrypt passwords, SHA-256 API-key hashes, AES-256-GCM webhook-secret encryption
    auth.js               sessions, HttpOnly cookies, HMAC CSRF tokens, rate limiting
    validate.js           input validation, HTML escaping, integer-paise parsing, UTC date parsing
    views.js              HTML layout and tables (all user data escaped)
    webhooks.js           HMAC webhook signing, delivery, backoff retries, audit + order events
    upi.js                pure UPI URI builder (integer paise, no floats)
    state-machine.js      order transition table (no pending -> success shortcut)
    db/pool.js            lazy mysql2 pool (parameterised queries only)
    db/migrate.js         versioned migration runner + CLI
    verification/adapter.js  verification-event validator (interface, not a success endpoint)
  public/
    css/style.css         responsive styles for desktop and mobile
    sdk.js                YoupiCheckout SDK (open a server-created checkout URL)
  tests/                  node:test suites, including live MySQL integration tests
  docs/
    API.md                merchant API, SDK, webhook verification, verification rules
    DEPLOYMENT.md         Hostinger / cPanel deployment, installer, diagnostics, troubleshooting
    VERIFICATION.md       Stage 1 verification notes (superseded in part by API.md)
  STAGE1.md               historical Stage 1 report (kept for audit trail)
  DELIVERY.md             complete-delivery report, test results, limitations
```

## Branding

YOUPI branding is preserved: the default app name is "YOUPI PG" and the
`merchants.branding` JSON column is kept. No new brand name is invented.

## Tests

```bash
cd gateway && npm install && npm test
```

Unit and logic tests always run. Live MySQL integration tests run only
when a disposable test database is provided, and are reported as skipped
otherwise (never as passed):

```bash
GATEWAY_TEST_MYSQL=1 DB_HOST=localhost DB_PORT=3306 \
  DB_USER=<test-user> DB_PASSWORD='<test-only-password>' \
  DB_NAME=<disposable-test-database> npm test
```

The integration suite covers the installer and locking, merchant
registration and pending status, admin approval, API key creation and
CSRF protection, API order creation, checkout QR and UPI URI, the rule
that "I have paid" moves an order to `processing` (never `success`),
the FIFO queue, manual verification with a valid HMAC-signed webhook,
duplicate-UTR rejection, merchant isolation, observer fingerprint
deduplication, sandbox success and the block on simulating a live order,
API key revocation, and HTML escaping. See `DELIVERY.md` for the exact
results from the environment where these tests were run.
