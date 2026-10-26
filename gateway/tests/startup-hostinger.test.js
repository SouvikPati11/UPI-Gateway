import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from '../src/server.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const gatewayRoot = path.resolve(__dirname, '..');

const testConfig = {
  nodeEnv: 'production', isProduction: true, port: 0, appName: 'YOUPI PG',
  baseUrl: '', verificationMode: 'manual',
  db: { configured: false, host: '', port: 3306, user: '', password: '', database: '', connectionLimit: 5 },
  sessionSecret: '', encryptionKey: '',
};

async function startServer(app) {
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  return { server, base: `http://127.0.0.1:${server.address().port}` };
}

async function closeServer(server) {
  await new Promise((resolve) => server.close(resolve));
}

test('degraded mode: invalid production config still serves diagnostics and blocks app routes', async () => {
  const configErrors = ['SESSION_SECRET is missing, a placeholder, or shorter than 32 characters.', 'DB_HOST is missing or a placeholder.'];
  const app = createApp({ config: testConfig, configErrors });
  const { server, base } = await startServer(app);
  try {
    const health = await fetch(`${base}/health`);
    assert.equal(health.status, 200);
    const healthJson = await health.json();
    assert.equal(healthJson.status, 'degraded');
    assert.equal(healthJson.config_valid, false);
    assert.deepEqual(healthJson.config_errors, configErrors);

    const ready = await fetch(`${base}/ready`);
    assert.equal(ready.status, 503);
    assert.equal((await ready.json()).reason, 'config_invalid');

    const dashboard = await fetch(`${base}/merchant/dashboard`);
    assert.equal(dashboard.status, 503);

    const api = await fetch(`${base}/api/v1/orders`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    assert.equal(api.status, 503);

    const checkout = await fetch(`${base}/checkout/YPTEST123`);
    assert.equal(checkout.status, 503);

    // The installer and diagnostics must still be reachable in degraded mode.
    const install = await fetch(`${base}/install`);
    assert.equal(install.status, 200);
    assert.match(await install.text(), /Install YOUPI PG/);

    const diagnostics = await fetch(`${base}/install/diagnostics`);
    assert.equal(diagnostics.status, 200);
    assert.equal((await diagnostics.json()).config_valid, false);
  } finally {
    await closeServer(server);
  }
});

test('slow database: server listens and /health responds quickly even when DB queries hang', async () => {
  // A pool whose query() never resolves in the test window. The old code
  // did not await the pool at startup, and this test pins that behaviour:
  // /health must not wait for the database.
  const slowPool = {
    query: () => new Promise(() => {}),
    getConnection: () => new Promise(() => {}),
  };
  const config = {
    ...testConfig,
    db: { ...testConfig.db, configured: true, host: '127.0.0.1', user: 'test', database: 'test' },
  };
  const app = createApp({ config, pool: slowPool });
  const startedAt = Date.now();
  const { server, base } = await startServer(app);
  const listenMs = Date.now() - startedAt;
  try {
    assert.ok(listenMs < 2000, `listen took ${listenMs} ms, expected < 2000 ms`);
    const healthStartedAt = Date.now();
    const health = await fetch(`${base}/health`);
    const healthMs = Date.now() - healthStartedAt;
    assert.equal(health.status, 200);
    assert.ok(healthMs < 2000, `/health took ${healthMs} ms, expected < 2000 ms`);
    assert.equal((await health.json()).status, 'ok');
  } finally {
    await closeServer(server);
  }
});

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function waitForHealth(base, timeoutMs) {
  const startedAt = Date.now();
  let lastError = null;
  while (Date.now() - startedAt < timeoutMs) {
    try {
      const res = await fetch(`${base}/health`);
      if (res.status === 200) return { elapsedMs: Date.now() - startedAt, body: await res.json() };
    } catch (err) {
      lastError = err;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`No /health response within ${timeoutMs} ms. Last error: ${lastError?.message || 'none'}`);
}

async function stopChild(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill('SIGTERM');
  await Promise.race([
    new Promise((resolve) => child.once('exit', resolve)),
    new Promise((resolve) => setTimeout(resolve, 3000)),
  ]);
  if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
}

// Hostinger simulation: run the real entry point (src/index.js) as a child
// process with a Hostinger-style environment (NODE_ENV=production, an
// assigned PORT, and either missing or valid-looking variables). The old
// code exited before listen() in the missing-config case; the fixed code
// must listen within Hostinger's 3-second window in both cases.
test('Hostinger simulation: child process listens within 3 seconds with missing production config', async () => {
  const port = await freePort();
  const child = spawn(process.execPath, ['src/index.js'], {
    cwd: gatewayRoot,
    env: {
      PATH: process.env.PATH,
      NODE_ENV: 'production',
      PORT: String(port),
      // Explicitly empty, so a stray gateway/.env cannot mask the case.
      APP_BASE_URL: '', SESSION_SECRET: '', ENCRYPTION_MASTER_KEY: '',
      DB_HOST: '', DB_USER: '', DB_PASSWORD: '', DB_NAME: '',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', (d) => { output += d; });
  child.stderr.on('data', (d) => { output += d; });
  try {
    const { elapsedMs, body } = await waitForHealth(`http://127.0.0.1:${port}`, 3000);
    assert.ok(elapsedMs < 3000, `health took ${elapsedMs} ms, expected < 3000 ms`);
    assert.equal(body.status, 'degraded');
    assert.equal(child.exitCode, null, `child exited early; output: ${output}`);
    assert.match(output, /Listening on port/);
    assert.match(output, /degraded\/setup mode/);
  } finally {
    await stopChild(child);
  }
});

test('Hostinger simulation: child process listens within 3 seconds with valid config but unreachable DB', async () => {
  const port = await freePort();
  const child = spawn(process.execPath, ['src/index.js'], {
    cwd: gatewayRoot,
    env: {
      PATH: process.env.PATH,
      NODE_ENV: 'production',
      PORT: String(port),
      APP_BASE_URL: 'https://example.invalid',
      SESSION_SECRET: 'a'.repeat(40),
      ENCRYPTION_MASTER_KEY: 'b'.repeat(64),
      DB_HOST: '127.0.0.1', DB_PORT: '3399', DB_USER: 'testuser', DB_PASSWORD: 'testpass123', DB_NAME: 'testdb',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', (d) => { output += d; });
  child.stderr.on('data', (d) => { output += d; });
  try {
    const { elapsedMs, body } = await waitForHealth(`http://127.0.0.1:${port}`, 3000);
    assert.ok(elapsedMs < 3000, `health took ${elapsedMs} ms, expected < 3000 ms`);
    assert.equal(body.status, 'ok');
    const ready = await fetch(`http://127.0.0.1:${port}/ready`);
    assert.equal(ready.status, 503);
    assert.equal((await ready.json()).reason, 'database_unavailable');
    assert.match(output, /Listening on port/);
  } finally {
    await stopChild(child);
  }
});
