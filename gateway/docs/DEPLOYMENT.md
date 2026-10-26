# YOUPI PG — Hostinger / cPanel Deployment Guide

This guide is for the `gateway/` application only (the single Express +
MySQL app on branch `feature/cpanel-mysql-gateway`). The original
8-service YOUPI project is not deployed by these steps.

> **Hostinger fix (v1.0.1, see HOSTINGER_FIX.md for the full root-cause
> report):** use the flat ZIP `youpi-gateway-hostinger-fixed.zip`, NOT the
> old nested `youpi-gateway-v1.0.0.zip`. The fixed ZIP extracts directly
> to the application root, so `package.json` and `src/index.js` are at the
> top level of the app folder. The exact Hostinger settings for the fixed
> ZIP are in section 2A below. If you see "App did not call listen()
> within 3 seconds" with the old ZIP, the two verified causes are
> (1) a production config error that previously threw before `listen()`
> and (2) the ZIP's `gateway/` nesting, which made `package.json` and
> `src/index.js` unreachable from the application root. Both are fixed in
> v1.0.1, and v1.0.1 starts in degraded/setup mode (with diagnostics on
> `/install/diagnostics`) instead of dying before `listen()` when a
> production variable is missing or placeholder-like.

## 1. Hosting requirements (exact)

Minimum requirements — do not deploy on a plan that cannot meet them:

- **Node.js >= 20.0.0** (Node 22 LTS recommended). The app will not run on
  Node < 20, and it will not run on a PHP-only plan.
- **MySQL 8.0+ or MariaDB 10.5+** (tested locally on MariaDB 10.11.14).
  The migrations use InnoDB, utf8mb4, JSON columns and CHECK constraints.
- **One long-running Node.js application** (cPanel "Setup Node.js App" or
  Hostinger's Node.js application feature), listening on the hosting-assigned
  `process.env.PORT`. The app must not be started with a fixed port.
- **One MySQL database** created in cPanel, with a database user added to it.
- An app folder **outside `public_html`** (for example `~/youpi-gateway/`),
  so that `.env`, source code and logs are not publicly accessible.
  The Node.js App panel's application URL is then mapped to your domain or
  subdomain (for example `https://gateway.example.com`).

### Plans that cannot run this application

- Any **PHP-only** hosting plan with no Node.js application support.
- Any plan that only offers Node.js < 20, or that does not allow a
  long-running Node.js process.
- Any plan with **no MySQL/MariaDB database** (SQLite-only, or a plan where
  you cannot create a database user).
- Any plan that only allows static files or CGI scripts.

If your plan is in this list, upgrade to a Hostinger plan with Node.js
application support and MySQL, or use a VPS. Do not claim compatibility
with a plan that cannot meet the list above.

## 2A. Exact Hostinger settings — fixed ZIP (use these, do not mix them with the old ZIP)

For `youpi-gateway-hostinger-fixed.zip` (v1.0.1, flat structure):

- **Application root:** the folder where the ZIP is extracted, outside
  `public_html` — for example `~/youpi-gateway/` (the folder itself, NOT
  a `gateway/` subfolder inside it). After extraction, `package.json`
  must be at `<application root>/package.json` and the entry point at
  `<application root>/src/index.js`. If you see a `gateway/` folder inside
  the application root after extraction, you used the old nested ZIP or
  extracted the fixed ZIP into the wrong folder — move its contents up
  one level and restart.
- **Startup file:** `src/index.js` (exactly this, relative to the
  application root). Do NOT use `gateway/src/index.js` with the fixed ZIP.
- **Node.js version:** `22` (minimum `20`). The app requires Node >= 20;
  Node 22 LTS is recommended.
- **Application URL:** your domain or subdomain, for example
  `https://gateway.example.com` (no trailing slash). This exact URL must
  also be set as `APP_BASE_URL` below.
- **Environment variables** (in the Hostinger Node.js App panel, not in a
  committed file; generate fresh secrets, never reuse placeholders):
  - `NODE_ENV=production`
  - `APP_BASE_URL=https://gateway.example.com` (your real URL)
  - `DB_HOST=localhost` (or the host Hostinger/cPanel shows for your database)
  - `DB_PORT=3306`
  - `DB_USER=<full database user name shown by Hostinger/cPanel>`
  - `DB_NAME=<full database name shown by Hostinger/cPanel>`
  - `DB_PASSWORD=<the password you set for that database user>`
  - `SESSION_SECRET=<at least 32 characters, generated — not "change-me" and not containing "change-me", "example.com" or "your-">`
  - `ENCRYPTION_MASTER_KEY=<exactly 64 hex characters, generated>`
  - `VERIFICATION_MODE=manual`
  - Optional, leave unset to disable: `OBSERVER_API_TOKEN`,
    `PROVIDER_WEBHOOK_SECRET`, `CRON_SECRET`.
  Generate a secret with, on your own machine:
  `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`
  **Do not set PORT yourself** — Hostinger assigns it. The app binds to
  `process.env.PORT` on `0.0.0.0` and falls back to `3000` only if PORT
  is missing or invalid, which it logs and reports in diagnostics.

## 2. Deployment path A — GitHub (recommended for updates)

1. Push the `feature/cpanel-mysql-gateway` branch to GitHub **only after
   explicit approval** (see DELIVERY.md: the branch is currently local and
   uncommitted because no Git author identity is configured).
2. In cPanel, open **Setup Node.js App** → **Create Application**.
3. Set **Node.js version** to 22 (or at least 20).
4. Set **Application root** to the folder where you will deploy the app
   (outside `public_html`, for example `youpi-gateway`).
5. Set **Application URL** to your domain or subdomain
   (for example `https://gateway.example.com`).
6. Set **Application startup file** to `src/index.js` when the application
   root is the `gateway/` folder itself (the fixed ZIP, or a Git checkout
   where you set the app root to the `gateway/` directory). Set it to
   `gateway/src/index.js` ONLY when the application root is the repository
   root and the `gateway/` folder is inside it. The application root must
   contain `package.json` at its top level — that is the test: if
   `<application root>/package.json` does not exist, the application root
   is wrong and the app cannot start.
7. In cPanel, create the MySQL database and user: **MySQL Databases** →
   create a database (for example `yourcpuser_youpi`), create a user, then
   **Add User to Database** with ALL PRIVILEGES.
8. In the Node.js App panel, add **Environment variables** (do not upload a
   `.env` file with real secrets):
   - `NODE_ENV=production`
   - `APP_BASE_URL=https://gateway.example.com` (your real URL, no trailing slash)
   - `DB_HOST=localhost` (or the host cPanel shows)
   - `DB_PORT=3306`
   - `DB_USER=<full cPanel database user name>`
   - `DB_NAME=<full cPanel database name>`
   - `DB_PASSWORD=<the password you set in cPanel>`
   - `SESSION_SECRET=<64 hex characters from a generator>`
   - `ENCRYPTION_MASTER_KEY=<64 hex characters from a generator>`
   - `VERIFICATION_MODE=manual`
   - Optional: `OBSERVER_API_TOKEN`, `PROVIDER_WEBHOOK_SECRET`, `CRON_SECRET`
     (leave unset to disable those features).
   Generate secrets with, on your own machine:
   `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`
9. Deploy the code (Git clone/pull in the app folder, or upload the ZIP from
   path B below), then run `npm install --omit=dev` in the app folder.
   The `gateway/` folder has only three runtime dependencies (Express,
   mysql2, qrcode); there is no build step.
10. Start (or restart) the Node.js application from the panel.
11. Open `https://gateway.example.com/install` and follow the wizard
    (section 3 below). Do not skip it: the wizard runs migrations and
    creates the first administrator, then locks itself.
12. Verify with `https://gateway.example.com/health` (should be
    `{"status":"ok",...}`) and `https://gateway.example.com/ready`
    (should be `{"status":"ready","installed":true}` after installation).

## 3. Deployment path B — Deployment ZIP (fixed ZIP, flat structure)

1. Use `youpi-gateway-hostinger-fixed.zip` (v1.0.1). It contains the
   gateway files at the **top level** of the ZIP (`package.json`,
   `src/index.js`, `src/`, `migrations/`, `public/`, `docs/`, `.env.example`),
   with **no `.env` file, no real credentials, no `node_modules`, and no
   `tests/`** (tests are development-only and are excluded from the
   deployment ZIP; run them from the repository, not from the host).
   You run `npm install --omit=dev` on the host after extraction.
2. In Hostinger **File Manager** (or cPanel File Manager), upload the ZIP
   to a folder **outside `public_html`** (for example `~/youpi-gateway/`)
   and extract it **into that folder**, so that `package.json` ends up at
   `~/youpi-gateway/package.json` — not at `~/youpi-gateway/gateway/package.json`.
   If you see a `gateway/` subfolder after extraction, you used the old
   nested ZIP: move its contents up one level.
3. Use the exact settings in section 2A above (Application root =
   the extraction folder, Startup file = `src/index.js`, Node.js 22).
4. Delete the uploaded ZIP file from the server after extraction, so it is
   not left publicly accessible.

## 4. Installation wizard (browser-based, no manual SQL)

Open `/install` in a browser. The wizard does, in order:

1. **Database connection test.** Enter the MySQL host, port, database name,
   user and password (the ones you created in cPanel). If the connection
   fails, no migration is run and the exact database error is shown
   (without the password).
2. **Existing-data check.** The wizard lists the tables it finds and the
   row counts for `merchants`, `orders` and `admins`. If the database
   already contains rows and you have not ticked the confirmation box,
   the wizard **refuses** to migrate and asks you to confirm (with a backup)
   and re-enter the password. Migrations only use `CREATE TABLE IF NOT EXISTS`
   and additive `ALTER` statements — they never drop or erase data.
3. **Migration execution.** Applies `001_init`, `002_order_mode_expiry` and
   `003_order_seq` in order, recording each in `schema_migrations`.
   Re-running migrations is idempotent: applied migrations report
   `already_applied`.
4. **First administrator creation.** Enter a name, email and password
   (at least 10 characters). There is no hardcoded admin password, and the
   installer does not create an admin if that email already exists.
5. **Installer locking.** The wizard sets `installed: true` in
   `app_settings`. After that, `/install` shows "Installer locked" and
   refuses to run again against the same database.
6. **Environment persistence.** If `gateway/.env` does not already exist,
   the wizard writes it (permissions 0600) with the database variables and
   freshly generated `SESSION_SECRET` / `ENCRYPTION_MASTER_KEY` (only if
   those were not already set in the environment). If a `.env` file already
   exists, it is **not** overwritten. For cPanel redeploys, also copy the
   same variables into the Node.js App panel and restart the app.

After installation, log in at `/admin/login` with the administrator you
just created, then approve merchants at `/admin/merchants`.

## 5. Diagnostics (deployment-time check, no manual SQL)

- `GET /health` — always available, no database required.
- `GET /ready` — `200 ready` only when the database is reachable;
  `503 database_not_configured` or `503 database_unavailable` otherwise.
- `GET /install/diagnostics` — JSON with Node version, Node >= 20 check,
  database configured/reachable, table list, migration versions and
  installed flag. **No password or secret is ever included in this output.**
- `POST /cron/expire` and `POST /cron/webhooks` — protected by
  `CRON_SECRET` when set; they expire overdue orders and retry due webhook
  deliveries. Set them up in cPanel **Cron Jobs** as, for example:
  - every 5 minutes: `curl -X POST -H "X-Cron-Secret: <your-secret>" https://gateway.example.com/cron/expire`
  - every 5 minutes: `curl -X POST -H "X-Cron-Secret: <your-secret>" https://gateway.example.com/cron/webhooks`
  Cron is optional: expiry is also checked on checkout load, and webhook
  retries can be triggered from the merchant dashboard. Do not put the
  cron secret in a public file or in chat.

## 6. Troubleshooting

- **Hostinger "App did not call listen() within 3 seconds" / 503 (v1.0.1 fix).**
  In v1.0.0 this had two verified causes, both fixed in v1.0.1 (see
  HOSTINGER_FIX.md): (1) a production config error threw in `index.js`
  before `listen()`, so the process died with no port open; (2) the old
  ZIP nested everything under `gateway/`, so `package.json` and
  `src/index.js` were not at the application root. In v1.0.1 the server
  listens promptly even with an invalid production config, in degraded /
  setup mode, and `/install/diagnostics` lists the exact config errors
  (no secret values). If you still get this error on v1.0.1, check in
  order: (a) Application root contains `package.json` at its top level;
  (b) Startup file is exactly `src/index.js`; (c) Node.js version is 22
  (or at least 20); (d) the runtime log contains a `[startup] Listening`
  line — if it contains a `[startup] Failed to listen` line instead, the
  assigned PORT is in use or the startup file is wrong; (e) open
  `/install/diagnostics` and fix every `config_errors` entry in the panel,
  then restart. A degraded `/health` response (`"status":"degraded"`) is
  NOT a working app — it means the config must be fixed and the app
  restarted.
- **"Production configuration invalid" on boot (v1.0.0 behaviour).**
  In v1.0.1 this no longer kills the process before `listen()`; the app
  starts in degraded mode and reports the errors on `/install/diagnostics`.
  Fix the Node.js App environment variables and restart; do not edit code
  to bypass the check, and do not serve merchant/admin traffic in degraded
  mode (those routes return 503 by design).
- **"/ready reports 503 database_unavailable".** Check `DB_HOST`, `DB_PORT`,
  `DB_USER`, `DB_NAME` and that the user is added to the database in cPanel.
  Use `/install/diagnostics` to see which check fails.
- **"Installer locked" on a fresh database.** You are pointed at a database
  that already has `installed: true`. Use a different database, or restore
  an empty database — never run the installer against a live database
  without a backup.
- **"Access denied for user".** The database user or password is wrong, or
  the user was not added to the database. Fix it in cPanel; never substitute
  production credentials to work around it.
- **Checkout shows a queue page.** That is correct FIFO behaviour: another
  order for the same merchant is ahead of it. It is promoted when the
  earlier order completes or expires (15 minutes).
- **Order stays pending after the customer paid.** That is correct: the
  order is pending verification. Verify it in **Admin → Verification queue**
  against the bank record, or configure an observer/provider (see docs/API.md).
  Never mark it successful from a screenshot or a customer message alone.
- **Webhook deliveries fail.** Check the merchant webhook URL, that it is
  `https` in production, and that the receiver returns 2xx and verifies the
  HMAC signature over the raw body. Delivery logs are in
  **Merchant → Webhooks** and **Admin → Webhooks**.

## 7. What is NOT deployed by these steps

- The original 8-service YOUPI topology (ports 5000–8090), WhatsApp OTP,
  Android SMS observer, Gmail observer and COD modules are **not** required
  and are not started by this app. They are documented as optional /
  unsupported for shared hosting in DELIVERY.md.
- No real provider integration is deployed by default. Provider mode
  requires a real provider contract and testing.
- No real money should be processed until you have tested the full flow
  in sandbox mode, verified a manual reconciliation end-to-end, and
  confirmed your UPI and bank arrangements for the merchants you onboard.
