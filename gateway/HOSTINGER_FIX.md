# Fix: Hostinger Node.js Startup Failure — "App did not call listen() within 3 seconds" (503)

Version: v1.0.1. Previous ZIP: `youpi-gateway-v1.0.0.zip` (nested `gateway/`).
Fixed ZIP: `youpi-gateway-hostinger-fixed.zip` (flat, see below).
Branch: `feature/cpanel-mysql-gateway` (local only, `main` untouched, nothing
pushed/merged/deployed to production by this fix).

**Do not claim this works on Hostinger until it has been tested there.**
The fix was verified locally by simulating Hostinger as closely as possible
(assigned PORT, `NODE_ENV=production`, the real entry point, and the flat
ZIP extracted to a fresh folder), but no Hostinger account was used in this
task. The Hostinger test steps are in section 6 below.

## 1. Verified root cause (not an assumption)

Two independent causes were reproduced locally, and a third suspected cause
was ruled out:

### Cause 1 (primary): production config validation threw BEFORE listen()

Old `src/index.js` did:

```js
const config = loadConfig(); // throws in production on any config error
const app = createApp({ config });
const server = app.listen(config.port, ...);
```

Old `src/config.js` `loadConfig()` throws
`Production configuration invalid` if, in production, ANY of these holds:
`SESSION_SECRET` missing / placeholder-like / shorter than 32 characters,
`ENCRYPTION_MASTER_KEY` not exactly 64 hex characters,
`APP_BASE_URL` missing / placeholder-like, or any of `DB_HOST`,
`DB_USER`, `DB_PASSWORD`, `DB_NAME` missing / placeholder-like.
"Placeholder-like" includes values containing `change-me`, `replace_with`,
`example.com`, `your-`, or exactly `password` / `secret` (case-insensitive).

Reproduction (old code, production, environment variables missing):

```
$ NODE_ENV=production PORT=34561 node src/index.js
Error: Production configuration invalid:
- SESSION_SECRET is missing, a placeholder, or shorter than 32 characters.
- ENCRYPTION_MASTER_KEY must be exactly 64 hex characters, not a placeholder.
- APP_BASE_URL is missing or a placeholder (example.com / change-me).
- DB_HOST is missing or a placeholder.
- DB_USER is missing or a placeholder.
- DB_PASSWORD is missing or a placeholder.
- DB_NAME is missing or a placeholder.
    at loadConfig (src/config.js:117)
    at src/index.js:8
Exit code: 1 — the process died before app.listen() was ever called.
```

Hostinger's supervisor waits up to 3 seconds for the app to listen, sees
no port, kills/restarts it, and serves 503 with
"App did not call listen() within 3 seconds". This happens even if only
ONE variable is wrong — for example a secret that happens to contain
`change-me`, a base URL still set to an example domain, or a panel variable
that was set on the wrong application and therefore never reached the
process. The user statement "environment variables are configured" was
therefore not taken at face value: the code path above is what the
Hostinger log is consistent with, and the fix makes the failure visible
instead of silent.

### Cause 2 (deployment structure): the old ZIP nested everything under gateway/

The old ZIP's top level was a single `gateway/` folder:

```
gateway/package.json
gateway/src/index.js
```

Reproduction (old ZIP extracted to a fresh folder, as Hostinger would):

```
$ unzip youpi-gateway-v1.0.0.zip   # in /tmp/hostinger-ziproot
$ ls
gateway
package.json at app root? NO
src/index.js at app root? NO
$ npm start
npm error ENOENT: Could not read package.json
```

If Hostinger's **Application root** is that extraction folder and the
**Startup file** is the natural `src/index.js`, the app cannot start at
all — `npm start` fails with ENOENT and `node src/index.js` fails the same
way. It only worked if the user manually set the application root to the
`gateway/` subfolder, which the old deployment guide gave only as one of
two ambiguous options. The fixed ZIP removes that ambiguity (flat structure).

### Ruled out: slow or unavailable database, migrations at startup

With valid-looking production variables and an unreachable database
(`DB_HOST=127.0.0.1`, `DB_PORT=3399`), the old code still listened and
answered `/health` in 293 ms in the local reproduction, because the MySQL
pool is lazy (`src/db/pool.js`: created only on first query) and no
migration runs at boot (migrations run only via `npm run migrate` or the
`/install` wizard). A slow database therefore does NOT explain the
3-second failure, and this fix does not move database work that was
already lazy. The regression test pins this: `/health` must respond in
under 2 seconds even when a database query never resolves.

### Also checked and found correct (not changed as a cause)

- No `require.main === module` conditional startup: `src/index.js` is an
  ES module that always calls `app.listen()` when run as the entry point,
  which is what Hostinger needs. There is no exported-only app that would
  never listen.
- No unresolved promise or blocking operation before `listen()` in the
  old code, other than the config throw above. Imports (`express`,
  `mysql2`, `qrcode`) complete in well under 1 second locally.
- `package.json` start script is correct: `"start": "node src/index.js"`,
  and all runtime dependencies (`express`, `mysql2`, `qrcode`) are in
  `dependencies`, not `devDependencies`. The old ZIP's lockfile was in sync
  with `package.json` (version 1.0.0, `qrcode` present), so `npm ci` /
  `npm install` failure was not a verified cause and is not claimed here.
- The app already bound to `process.env.PORT` (via `config.port`) with a
  3000 fallback; the fix makes the binding explicit (`0.0.0.0`) and logs it.

## 2. The fix

### src/index.js (rewritten startup)

- Logs immediately (`[startup] YOUPI PG starting (pid, node version)`),
  so a startup failure is visible in the runtime log.
- Validates with `validateConfig()` instead of the throwing `loadConfig()`.
  Production errors no longer exit before `listen()`.
- If production config is invalid, it starts in **degraded/setup mode**
  (see `src/app.js` below), logs every config error, and logs that
  `/ready` will stay 503 until the variables are fixed and the app is
  restarted.
- Binds explicitly with `app.listen(port, '0.0.0.0', ...)` on the
  Hostinger-assigned `process.env.PORT`, with a 3000 fallback only when
  PORT is missing or invalid (logged and reported in diagnostics).
- Logs `Listening on port <port> after <ms> ms` in the listen callback.
- Adds a `server.on('error', ...)` handler that logs the exact listen
  failure (`EADDRINUSE`, `EACCES`, etc.) and exits with code 1 — a listen
  failure is now a clear log line, not a silent 3-second timeout.
- No database connection, migration, or other slow work is added before
  `listen()`. The pool remains lazy and migrations remain manual/wizard-only.

### src/app.js (degraded/setup mode)

When `createApp()` receives a non-empty `configErrors` list (production
only, from `index.js`):

- `GET /health` returns `200` with `"status":"degraded"`,
  `"config_valid": false` and the exact `config_errors` list (messages
  only, never secret values). This proves the process is listening; it
  does **not** claim the app is ready.
- `GET /ready` returns `503` with `reason: "config_invalid"`.
- `GET /` shows the config errors and links to `/install` and diagnostics.
- `GET /install/diagnostics` returns Node version, Node >= 20 check,
  config validity and errors, and database reachability (attempted only
  if a pool can be created, with errors reported, not thrown).
- A middleware blocks **every other route** (merchant, admin, API,
  checkout, webhook, provider) with `503` and the config errors, before
  any of those routes run. No session is created with a placeholder secret
  and no order is processed in degraded mode.
- `/install` and `/public/*` are allowed through, so the installer (which
  uses form-supplied database values, not the broken panel variables) can
  still run, and the diagnostics page is styled.

### src/config.js

- `PORT` parsing: if `PORT` is set but is not an integer in 1–65535, it
  records a config error and falls back to 3000, instead of passing `NaN`
  to `listen()`. `validateConfig()` itself is unchanged in its production
  rules (so existing config tests still pass); only the server startup
  path changed from "throw before listen" to "listen in degraded mode".
  The `migrate` CLI still uses the throwing `loadConfig()`, which is
  correct for a manually run CLI (it is not under Hostinger's 3-second
  window).

### src/app.js (installer, small fix)

- When the installer writes `.env`, a placeholder-like `APP_BASE_URL`
  (containing `example.com` or `change-me`) is no longer written into the
  file; it is left blank so a real panel value must be set. This prevents
  the installer from recreating the exact config error that caused the
  original failure.

### package.json / package-lock.json

- Version bumped to `1.0.1` to distinguish the fixed build.
- Lockfile regenerated with `npm install` so it is in sync with
  `package.json` (Express, mysql2, qrcode). No dependency versions were
  changed.

### Docs

- `docs/DEPLOYMENT.md`: new section 2A with the exact Hostinger settings
  for the fixed ZIP, corrected startup-file guidance (the application root
  must contain `package.json` at its top level — that is the test), a
  corrected flat-ZIP path B, and a 503 troubleshooting section.
- This file (`HOSTINGER_FIX.md`) is the root-cause report.

## 3. Files changed and why

- `gateway/src/index.js` — rewritten startup: no throw before listen,
  degraded mode, explicit `0.0.0.0:PORT` binding, startup timing and
  listen-error logs. (Primary fix.)
- `gateway/src/app.js` — degraded/setup mode middleware and routes;
  installer `.env` placeholder-base-URL fix. (Makes the failure diagnosable
  without weakening security.)
- `gateway/src/config.js` — valid PORT parsing with error + fallback.
  (Prevents a `NaN` port from breaking `listen()`.)
- `gateway/package.json`, `gateway/package-lock.json` — version 1.0.1,
  lockfile in sync. (Distinguishes the fixed build.)
- `gateway/tests/startup-hostinger.test.js` — NEW regression tests (see
  section 5).
- `gateway/docs/DEPLOYMENT.md` — exact Hostinger settings, flat-ZIP path,
  503 troubleshooting. (Prevents the ZIP-root mistake from recurring.)
- `gateway/HOSTINGER_FIX.md` — this report.
- `gateway/README.md` — link to this fix (short note added).
- Everything else (merchant dashboard, admin panel, authentication, MySQL
  schema and migrations, API, checkout, webhook handling, manual
  verification mode, security checks) is **unchanged**. No security check
  was removed and no payment verification was faked: degraded mode blocks
  those features entirely until the config is fixed.

## 4. What was NOT changed, deliberately

- Production validation rules themselves were not weakened: placeholder
  secrets, short secrets, non-hex encryption keys and missing database
  variables are still errors. The change is only in *when* they are
  reported (after listening, in degraded mode, with diagnostics) instead
  of *before* listening (process death, 503, no diagnosis).
- `/ready` still returns 503 when the database is unavailable or the
  config is invalid. Degraded `/health` (`"status":"degraded"`) must not
  be read as "ready".
- No port is hardcoded. The app binds to `process.env.PORT` when valid.
  The 3000 fallback is only for a missing/invalid PORT and is logged.

## 5. Tests actually executed and results

All tests below were run in the sandbox (Node v24.22.1, MariaDB 10.11.14
available locally for the full suite).

- **New regression suite** `tests/startup-hostinger.test.js` + existing
  config/server tests: **12 passed, 0 failed**
  (`node --test tests/startup-hostinger.test.js tests/config.test.js tests/server.test.js`).
  New tests:
  1. Degraded mode serves `/health` (degraded), `/ready` (503),
     blocks `/merchant/dashboard`, `/api/v1/orders` and `/checkout/*`
     (503), and still serves `/install` and `/install/diagnostics`.
  2. Slow database: with a pool whose `query()` never resolves, the
     server still listens and `/health` responds in under 2 seconds.
  3. Hostinger simulation (child process, real `src/index.js`,
     `NODE_ENV=production`, assigned PORT, missing config): child does
     not exit, `/health` returns degraded in ~346 ms (well under 3000 ms),
     log contains `Listening on port` and `degraded/setup mode`.
  4. Hostinger simulation (child process, valid config, unreachable DB):
     `/health` returns ok in ~354 ms, `/ready` returns 503
     `database_unavailable`, log contains `Listening on port`.
- **Manual Hostinger-style checks** (before/after, same commands):
  - Before fix, missing production config: exit code 1, no listen (see
    section 1). After fix, missing production config: server-side listen
    after 18 ms, end-to-end `/health` (degraded) in under 1 second,
    `/ready` 503 `config_invalid`, `/merchant/dashboard` 503,
    `/install/diagnostics` lists all 7 config errors.
  - Before fix, valid config + unreachable DB: listen + `/health` in
    293 ms (DB was already not a cause). After fix: listen after 20 ms,
    `/health` ok, `/ready` 503 `database_unavailable`.
  - Before fix, old ZIP extracted to a fresh folder: `package.json` and
    `src/index.js` NOT at the app root, `npm start` fails ENOENT.
    After fix, flat ZIP (see section 7): both files at the app root.
- **Full gateway suite after the fix** (with disposable MariaDB, as in
  the previous delivery): **36 passed, 0 failed, 0 skipped**
  (`npm test` with `GATEWAY_TEST_MYSQL=1` and disposable `DB_*` variables).
  That is the previous 32 tests plus the 4 new startup tests above.
  Without a database, the unit tests pass and the live integration tests
  are reported as skipped, never as passed.

## 6. Exact Hostinger settings (fixed ZIP)

- **Application root:** the folder where
  `youpi-gateway-hostinger-fixed.zip` is extracted, outside `public_html`,
  for example `~/youpi-gateway/`. After extraction, verify:
  `<application root>/package.json` exists and
  `<application root>/src/index.js` exists. If you see a `gateway/`
  subfolder instead, you extracted the wrong ZIP or into the wrong folder.
- **Startup file:** `src/index.js`
- **Node.js version:** `22` (minimum `20`)
- **Application URL:** your domain/subdomain, e.g.
  `https://gateway.example.com` (no trailing slash)
- **Environment variables** (Hostinger Node.js App panel):
  `NODE_ENV=production`,
  `APP_BASE_URL=https://gateway.example.com` (your real URL),
  `DB_HOST=localhost` (or the host Hostinger shows),
  `DB_PORT=3306`,
  `DB_USER=<full database user name>`,
  `DB_NAME=<full database name>`,
  `DB_PASSWORD=<database user password>`,
  `SESSION_SECRET=<at least 32 characters, generated>`,
  `ENCRYPTION_MASTER_KEY=<exactly 64 hex characters, generated>`,
  `VERIFICATION_MODE=manual`
  (optional, leave unset to disable: `OBSERVER_API_TOKEN`,
  `PROVIDER_WEBHOOK_SECRET`, `CRON_SECRET`).
  Do **not** set `PORT` yourself — Hostinger assigns it.
  Do **not** use values containing `change-me`, `example.com`, `your-`,
  or exactly `password`/`secret` — the validator treats those as
  placeholders and the app will stay in degraded mode.
- **After starting:** open `/install/diagnostics` first. It must show
  `"config_valid": true` (or, before installation, no `config_errors`
  field at all in the full-app diagnostics) and, after installation,
  `/ready` must show `{"status":"ready","installed":true}`. If
  `/health` shows `"status":"degraded"`, fix every `config_errors` entry
  in the panel and restart — do not proceed to merchant/admin use.
  Then open `/install` to run migrations and create the first admin.

## 7. Fixed ZIP contents and verification

`youpi-gateway-hostinger-fixed.zip` is a **flat** ZIP: its top level is
the gateway files themselves (`package.json`, `src/`, `migrations/`,
`public/`, `docs/`, `.env.example`, `README.md`, `DELIVERY.md`,
`HOSTINGER_FIX.md`), with no wrapping `gateway/` folder.

Excluded, as required: `.env`, real secrets, `node_modules`, and
development-only files (`tests/`). Run `npm install --omit=dev` on the
host after extraction; there is no build step.

Verification performed on the built ZIP (in the sandbox, before delivery):
extracted to a fresh folder, confirmed `package.json` and `src/index.js`
at the top level, confirmed no `.env` and no `node_modules` inside the
ZIP, ran `npm install --omit=dev` in the extracted folder, started it
with Hostinger-style production variables (assigned PORT, valid config,
unreachable DB) and confirmed it listened in under 3 seconds with
`/health` ok and `/ready` 503 `database_unavailable`, and started it
with missing production variables and confirmed it listened in degraded
mode with `/install/diagnostics` listing the config errors.

## 8. What to do on Hostinger now

1. Delete or rename the old application (old nested ZIP) — do not run
   both at once on the same PORT/domain.
2. Upload `youpi-gateway-hostinger-fixed.zip`, extract it to the
   application root in section 6, and set the exact settings there.
3. Run `npm install --omit=dev` in the application root (Hostinger may
   do this automatically; if it does not, run it from the panel's terminal
   or File Manager equivalent).
4. Start/restart the application and check the runtime log for
   `[startup] Listening on port <assigned PORT> after <ms> ms`. If you
   see `[startup] Failed to listen`, fix the startup file / application
   root as in section 6. If you see degraded mode, fix the panel variables
   listed in `/install/diagnostics` and restart.
5. Open `/install/diagnostics`, then `/install` to run migrations and
   create the first admin, then verify `/ready` shows installed: true.
6. If the 503 persists after these steps, send the runtime log lines
   starting with `[startup]` and the `/install/diagnostics` output
   (which contains no secrets) — those two outputs now identify the
   remaining cause instead of a generic 3-second timeout.
