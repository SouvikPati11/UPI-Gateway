import { loadLocalEnvFile, validateConfig } from './config.js';
import { createApp } from './server.js';
import { closePool } from './db/pool.js';

// Hostinger startup contract, in order:
//  1. Log immediately, so a startup failure is visible in the runtime log.
//  2. Validate configuration WITHOUT throwing before listen(). Previously
//     loadConfig() threw here on any production config error, so the
//     process died before app.listen() and Hostinger reported
//     "App did not call listen() within 3 seconds" with a 503. Now an
//     invalid production config starts the server in degraded/setup mode
//     (see app.js): it still listens promptly, serves /health (degraded),
//     /ready (503), / and /install/diagnostics with the exact errors, and
//     blocks merchant/admin/API/checkout routes. It never claims to be
//     ready and never creates sessions with a placeholder secret.
//  3. Bind explicitly to 0.0.0.0 on process.env.PORT (Hostinger-assigned).
//     The 3000 fallback is used only when PORT is missing or invalid, and
//     that case is logged and reported in diagnostics.
//  4. No database connection, migration, or other slow work runs before
//     listen(). The MySQL pool is lazy (see db/pool.js) and migrations run
//     only via `npm run migrate` or the /install wizard, never at boot.
const startedAt = Date.now();
console.log(`[startup] YOUPI PG starting (pid ${process.pid}, node ${process.version})`);

loadLocalEnvFile();
const { config, errors } = validateConfig(process.env);
// Only production errors put the app in degraded mode. Non-production
// warnings (for example a placeholder session secret in development) are
// logged but do not block local development or tests.
const configErrors = config.isProduction ? errors : [];
if (errors.length > 0) {
  for (const error of errors) console.error(`[startup] Config error: ${error}`);
  if (configErrors.length > 0) {
    console.error('[startup] Starting in degraded/setup mode: the server will listen promptly, but merchant, admin, API and checkout routes are disabled until the environment variables are fixed and the app is restarted. See /install/diagnostics.');
  }
}

let port = config.port;
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  console.error(`[startup] Invalid port ${String(port)}; falling back to 3000. Set a valid PORT in the hosting panel.`);
  port = 3000;
}
console.log(`[startup] Binding to 0.0.0.0:${port} (PORT from environment: ${process.env.PORT || '(not set, using fallback)'})`);

const app = createApp({ config, configErrors });

const server = app.listen(port, '0.0.0.0', () => {
  const elapsedMs = Date.now() - startedAt;
  console.log(`[startup] Listening on port ${port} after ${elapsedMs} ms [${config.nodeEnv}]${configErrors.length > 0 ? ' [degraded/setup mode]' : ''}`);
  console.log(`Health: /health  |  Readiness: /ready  |  Diagnostics: /install/diagnostics  |  Verification mode: ${config.verificationMode}`);
  if (configErrors.length > 0) {
    console.log('[startup] Degraded mode: fix the config errors above in the hosting panel and restart. /ready will stay 503 until then.');
  } else if (!config.db.configured) {
    console.log('Database: not configured — /ready will report 503 until DB_* variables are set and migrations are run. Open /install.');
  }
});

server.on('error', (err) => {
  console.error(`[startup] Failed to listen on port ${port}: ${err.code || ''} ${err.message}`);
  console.error('[startup] Check that the hosting panel assigned PORT is not already in use and that the startup file is src/index.js from the application root.');
  process.exit(1);
});

async function shutdown(signal) {
  console.log(`Received ${signal}; shutting down.`);
  server.close(async () => {
    await closePool().catch(() => {});
    process.exit(0);
  });
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
