import test, { describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';

// Live integration tests — run ONLY when a disposable test database is
// provided. Otherwise every test in this file is skipped (reported as a
// skip, never as a pass). Run with, for example:
//   GATEWAY_TEST_MYSQL=1 DB_HOST=localhost DB_PORT=3306 \
//   DB_USER=youpi_test DB_PASSWORD='<test-only-password>' \
//   DB_NAME=youpi_gateway_test npm test
// The database named here is dropped and recreated by the test setup, so
// it must be disposable and must never be a production database.
const enabled = process.env.GATEWAY_TEST_MYSQL === '1'
  && Boolean(process.env.DB_HOST && process.env.DB_USER && process.env.DB_PASSWORD && process.env.DB_NAME);

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const gatewayRoot = path.resolve(__dirname, '..');

describe('Live integration (disposable MySQL only)', { skip: !enabled }, () => {
  let pool;
  let server;
  let base;
  let config;
  let webhookServer;
  let webhookPort;
  let webhookEvents = [];
  let merchantId;
  let merchant2Id;
  let adminCookie;
  let merchantCookie;
  let merchant2Cookie;
  let secretKey;
  let webhookSecret;
  let liveRef;
  let sandboxRef;
  let queuedRef;
  let thirdRef;

  function cookieFrom(res) {
    // Undici (Node fetch) does not expose Set-Cookie via headers.get();
    // use getSetCookie() when available.
    const cookies = typeof res.headers.getSetCookie === 'function'
      ? res.headers.getSetCookie()
      : [res.headers.get('set-cookie')];
    for (const setCookie of cookies) {
      if (!setCookie) continue;
      const match = /gw_session=([^;]+)/.exec(setCookie);
      if (match) return decodeURIComponent(match[1]);
    }
    return null;
  }

  async function req(method, urlPath, { body, cookie, headers = {}, redirect = 'follow' } = {}) {
    const isForm = body && typeof body === 'object' && !(body instanceof URLSearchParams) && !headers['Content-Type'];
    let payload = null;
    const h = { ...headers };
    if (body) {
      if (typeof body === 'string') { payload = body; h['Content-Type'] = h['Content-Type'] || 'application/json'; }
      else if (body instanceof URLSearchParams) { payload = body.toString(); h['Content-Type'] = 'application/x-www-form-urlencoded'; }
      else { payload = new URLSearchParams(body).toString(); h['Content-Type'] = 'application/x-www-form-urlencoded'; }
    }
    if (cookie) h.Cookie = `gw_session=${encodeURIComponent(cookie)}`;
    const res = await fetch(`${base}${urlPath}`, { method, headers: h, body: payload, redirect });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* html */ }
    return { status: res.status, text, json, cookie: cookieFrom(res), location: res.headers.get('location') };
  }

  function form(obj) { return new URLSearchParams(obj); }

  before(async () => {
    process.env.OBSERVER_API_TOKEN = 'test-observer-token-123';
    const mysql = await import('mysql2/promise');
    pool = mysql.createPool({
      host: process.env.DB_HOST, port: Number(process.env.DB_PORT || 3306),
      user: process.env.DB_USER, password: process.env.DB_PASSWORD, database: process.env.DB_NAME,
      connectionLimit: 5, waitForConnections: true, dateStrings: true, multipleStatements: false,
    });
    await pool.query('SET FOREIGN_KEY_CHECKS=0');
    for (const table of ['webhook_deliveries', 'order_events', 'verification_events', 'orders', 'merchant_api_keys', 'sessions', 'receiving_accounts', 'merchants', 'admins', 'audit_logs', 'app_settings', 'schema_migrations']) {
      await pool.query(`DROP TABLE IF EXISTS \`${table}\``);
    }
    await pool.query('SET FOREIGN_KEY_CHECKS=1');

    config = {
      nodeEnv: 'test', isProduction: false, port: 0, appName: 'YOUPI PG',
      baseUrl: 'http://127.0.0.1', verificationMode: 'manual',
      db: { configured: true, host: process.env.DB_HOST, port: Number(process.env.DB_PORT || 3306), user: process.env.DB_USER, password: process.env.DB_PASSWORD, database: process.env.DB_NAME, connectionLimit: 5 },
      sessionSecret: 'a'.repeat(40), encryptionKey: 'b'.repeat(64),
    };
    const { migrate } = await import('../src/db/migrate.js');
    const results = await migrate({ config, apply: true, pool });
    assert.deepEqual(results.map((r) => r.status), ['applied', 'applied', 'applied', 'applied']);

    webhookEvents = [];
    webhookServer = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        webhookEvents.push({ headers: req.headers, body });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end('{"ok":true}');
      });
    });
    await new Promise((resolve) => { webhookServer.listen(0, '127.0.0.1', resolve); });
    webhookPort = webhookServer.address().port;

    const { createApp } = await import('../src/app.js');
    const app = createApp({ config, pool });
    await new Promise((resolve) => { server = app.listen(0, '127.0.0.1', resolve); });
    base = `http://127.0.0.1:${server.address().port}`;
  });

  after(async () => {
    if (server) await new Promise((resolve) => server.close(resolve));
    if (webhookServer) await new Promise((resolve) => webhookServer.close(resolve));
    if (pool) await pool.end();
    // The installer test may have created gateway/.env with test-only
    // credentials. Remove it so no test credential is left behind.
    const envPath = path.join(gatewayRoot, '.env');
    try { if (fs.existsSync(envPath)) fs.unlinkSync(envPath); } catch {}
  });

  test('installer creates the first admin and then locks', async () => {
    const r = await req('POST', '/install', { body: form({
      db_host: process.env.DB_HOST, db_port: String(process.env.DB_PORT || 3306),
      db_name: process.env.DB_NAME, db_user: process.env.DB_USER, db_password: process.env.DB_PASSWORD,
      admin_name: 'Test Admin', admin_email: 'admin@example.test', admin_password: 'TestAdmin1234', admin_password_confirm: 'TestAdmin1234',
      confirm_empty_or_checked: 'yes',
    }) });
    assert.equal(r.status, 200, r.text.slice(0, 500));
    assert.match(r.text, /Installation complete/);
    const locked = await req('GET', '/install');
    assert.match(locked.text, /Installer locked|already installed/);
  });

  test('merchant registration and pending dashboard', async () => {
    const r = await req('POST', '/merchant/register', { body: form({
      business_name: 'Acme Test Store', slug: 'acme-test', contact_email: 'acme@example.test',
      contact_phone: '9876543210', upi_id: 'acme@okhdfc', payee_name: 'Acme Test', password: 'MerchantPass123',
    }) });
    assert.match(r.text, /pending approval/);
    const login = await req('POST', '/merchant/login', { body: form({ email: 'acme@example.test', password: 'MerchantPass123' }), redirect: 'manual' });
    assert.ok(login.cookie, 'merchant login should set a session cookie');
    merchantCookie = login.cookie;
    const dash = await req('GET', '/merchant/dashboard', { cookie: merchantCookie });
    assert.match(dash.text, /pending/);
    const [rows] = await pool.query('SELECT id FROM merchants WHERE slug = ?', ['acme-test']);
    merchantId = rows[0].id;
  });

  test('admin approves the merchant', async () => {
    const login = await req('POST', '/admin/login', { body: form({ email: 'admin@example.test', password: 'TestAdmin1234' }), redirect: 'manual' });
    assert.ok(login.cookie);
    adminCookie = login.cookie;
    const { csrfTokenFor } = await import('../src/auth.js');
    const csrf = csrfTokenFor(adminCookie, config.sessionSecret);
    const approve = await req('POST', `/admin/merchants/${merchantId}/approve`, { cookie: adminCookie, body: form({ _csrf: csrf }), redirect: 'manual' });
    assert.ok([200, 302].includes(approve.status), `approve status ${approve.status}`);
    const [rows] = await pool.query('SELECT status FROM merchants WHERE id = ?', [merchantId]);
    assert.equal(rows[0].status, 'approved');
  });

  test('merchant API key creation and webhook setup', async () => {
    const { csrfTokenFor } = await import('../src/auth.js');
    const csrf = csrfTokenFor(merchantCookie, config.sessionSecret);
    const created = await req('POST', '/merchant/api-keys', { cookie: merchantCookie, body: form({ _csrf: csrf, name: 'Website', key_type: 'secret' }), redirect: 'manual' });
    assert.equal(created.status, 302);
    const loc = new URL(created.location, base);
    secretKey = loc.searchParams.get('new_key');
    assert.ok(secretKey && secretKey.startsWith('sk_'), 'secret key should be shown once on redirect');
    // Webhook URL + secret, for signature verification later.
    await req('POST', '/merchant/webhooks', { cookie: merchantCookie, body: form({ _csrf: csrf, webhook_url: `http://127.0.0.1:${webhookPort}/webhook` }), redirect: 'manual' });
    const secretRes = await req('POST', '/merchant/webhooks/secret', { cookie: merchantCookie, body: form({ _csrf: csrf }), redirect: 'manual' });
    webhookSecret = new URL(secretRes.location, base).searchParams.get('new_secret');
    assert.ok(webhookSecret && webhookSecret.length >= 32);
    // CSRF protection: a POST without a valid token must fail.
    const bad = await req('POST', '/merchant/api-keys', { cookie: merchantCookie, body: form({ name: 'Bad', key_type: 'secret' }) });
    assert.equal(bad.status, 403);
  });

  test('API order creation, checkout QR, and paid-click does not succeed', async () => {
    const created = await req('POST', '/api/v1/orders', {
      headers: { Authorization: `Bearer ${secretKey}` },
      body: JSON.stringify({ merchant_order_id: 'ORDER-1001', amount_paise: 49900, mode: 'live', customer_name: 'Test Customer' }),
    });
    assert.equal(created.status, 201, created.text.slice(0, 500));
    liveRef = created.json.order.gateway_reference;
    assert.ok(liveRef);

    const checkout = await req('GET', `/checkout/${liveRef}`);
    assert.equal(checkout.status, 200);
    assert.match(checkout.text, /data:image\/png/);
    assert.match(checkout.text, /upi:\/\/pay\?/);
    assert.match(checkout.text, /am=499\.00/);

    const paid = await req('POST', `/checkout/${liveRef}/paid`, { redirect: 'manual' });
    assert.ok([200, 302].includes(paid.status));
    const status = await req('GET', `/api/public/orders/${liveRef}/status`);
    assert.equal(status.json.status, 'processing', 'I have paid must move to processing, never to success');
    assert.equal(status.json.verification_source, 'none');
  });

  test('FIFO queue: a second order waits while the first is processing', async () => {
    const created = await req('POST', '/api/v1/orders', {
      headers: { Authorization: `Bearer ${secretKey}` },
      body: JSON.stringify({ merchant_order_id: 'ORDER-1002', amount_paise: 10000, mode: 'live' }),
    });
    assert.equal(created.status, 201);
    queuedRef = created.json.order.gateway_reference;
    const checkout = await req('GET', `/checkout/${queuedRef}`);
    assert.match(checkout.text, /payment queue|queue position/i);
    assert.doesNotMatch(checkout.text, /data:image\/png/);
  });

  test('manual verification succeeds once and rejects a duplicate UTR', async () => {
    const { csrfTokenFor } = await import('../src/auth.js');
    const csrf = csrfTokenFor(adminCookie, config.sessionSecret);
    const ok = await req('POST', `/admin/verify/${liveRef}/success`, { cookie: adminCookie, body: form({ _csrf: csrf, utr: '123456789012' }), redirect: 'manual' });
    assert.ok([200, 302].includes(ok.status), `verify status ${ok.status}`);
    const status = await req('GET', `/api/public/orders/${liveRef}/status`);
    assert.equal(status.json.status, 'success');
    assert.equal(status.json.verification_source, 'manual');

    // Webhook: a SUCCESS event must have arrived with a valid HMAC signature.
    const successEvents = webhookEvents.filter((e) => {
      try { return JSON.parse(e.body).event === 'SUCCESS'; } catch { return false; }
    });
    assert.ok(successEvents.length >= 1, 'expected at least one SUCCESS webhook');
    const ev = successEvents[successEvents.length - 1];
    const expected = 'sha256=' + crypto.createHmac('sha256', webhookSecret).update(ev.body).digest('hex');
    assert.equal(ev.headers['x-gateway-signature'], expected);
    assert.ok(ev.headers['x-gateway-delivery-id']);
    assert.ok(Number(ev.headers['x-gateway-timestamp']) > 0);

    // Duplicate UTR for the same merchant must be rejected.
    const created = await req('POST', '/api/v1/orders', {
      headers: { Authorization: `Bearer ${secretKey}` },
      body: JSON.stringify({ merchant_order_id: 'ORDER-1003', amount_paise: 49900, mode: 'live' }),
    });
    thirdRef = created.json.order.gateway_reference;
    await req('POST', `/checkout/${thirdRef}/paid`, { redirect: 'manual' });
    const dup = await req('POST', `/admin/verify/${thirdRef}/success`, { cookie: adminCookie, body: form({ _csrf: csrf, utr: '123456789012' }) });
    assert.equal(dup.status, 409);
    assert.match(dup.text, /Duplicate UTR/);
  });

  test('merchant isolation: a second merchant cannot read the first merchant order', async () => {
    await req('POST', '/merchant/register', { body: form({
      business_name: 'Other Store', slug: 'other-store', contact_email: 'other@example.test',
      contact_phone: '9876543211', upi_id: 'other@okhdfc', payee_name: 'Other', password: 'MerchantPass123',
    }) });
    const [rows] = await pool.query('SELECT id FROM merchants WHERE slug = ?', ['other-store']);
    merchant2Id = rows[0].id;
    const { csrfTokenFor } = await import('../src/auth.js');
    await req('POST', `/admin/merchants/${merchant2Id}/approve`, { cookie: adminCookie, body: form({ _csrf: csrfTokenFor(adminCookie, config.sessionSecret) }), redirect: 'manual' });
    const login = await req('POST', '/merchant/login', { body: form({ email: 'other@example.test', password: 'MerchantPass123' }), redirect: 'manual' });
    merchant2Cookie = login.cookie;
    const page = await req('GET', `/merchant/orders/${liveRef}`, { cookie: merchant2Cookie });
    assert.equal(page.status, 404);
    const api = await req('GET', `/api/v1/orders/${liveRef}`, { headers: { Authorization: `Bearer ${secretKey}` } });
    // The first merchant's own key can still read it (control case).
    assert.equal(api.status, 200);
  });

  test('observer events are deduplicated by fingerprint', async () => {
    const created = await req('POST', '/api/v1/orders', {
      headers: { Authorization: `Bearer ${secretKey}` },
      body: JSON.stringify({ merchant_order_id: 'ORDER-1004', amount_paise: 25000, mode: 'live' }),
    });
    const ref = created.json.order.gateway_reference;
    await req('POST', `/checkout/${ref}/paid`, { redirect: 'manual' });
    const eventBody = JSON.stringify({ merchant_id: merchantId, gateway_reference: ref, amount_paise: 25000, utr: '987654321098', fingerprint_hash: 'f'.repeat(64) });
    const first = await req('POST', '/api/v1/observers/events', { headers: { 'X-Observer-Token': 'test-observer-token-123' }, body: eventBody });
    assert.equal(first.json.status, 'success');
    const second = await req('POST', '/api/v1/observers/events', { headers: { 'X-Observer-Token': 'test-observer-token-123' }, body: eventBody });
    assert.equal(second.json.duplicate, true);
    const status = await req('GET', `/api/public/orders/${ref}/status`);
    assert.equal(status.json.status, 'success');
    assert.equal(status.json.verification_source, 'observer');
  });

  test('sandbox flow succeeds with a synthetic reference, live sandbox-simulate is blocked', async () => {
    await req('POST', `/checkout/${queuedRef}/cancel`, { redirect: 'manual' });
    await req('POST', `/checkout/${thirdRef}/cancel`, { redirect: 'manual' });
    const created = await req('POST', '/api/v1/orders', {
      headers: { Authorization: `Bearer ${secretKey}` },
      body: JSON.stringify({ merchant_order_id: 'ORDER-SANDBOX-1', amount_paise: 1000, mode: 'sandbox' }),
    });
    assert.equal(created.status, 201);
    sandboxRef = created.json.order.gateway_reference;
    const checkout = await req('GET', `/checkout/${sandboxRef}`);
    assert.match(checkout.text, /SANDBOX/);
    const simulated = await req('POST', `/checkout/${sandboxRef}/sandbox-simulate`, { redirect: 'manual' });
    assert.ok([200, 302].includes(simulated.status));
    const status = await req('GET', `/api/public/orders/${sandboxRef}/status`);
    assert.equal(status.json.status, 'success');
    assert.equal(status.json.verification_source, 'sandbox');

    // A live order must never be simulated.
    const live = await req('POST', '/api/v1/orders', {
      headers: { Authorization: `Bearer ${secretKey}` },
      body: JSON.stringify({ merchant_order_id: 'ORDER-LIVE-NOSIM', amount_paise: 1000, mode: 'live' }),
    });
    const blocked = await req('POST', `/checkout/${live.json.order.gateway_reference}/sandbox-simulate`);
    assert.equal(blocked.status, 403);
  });

  test('revoked API key is rejected and checkout escapes merchant-controlled input', async () => {
    const { csrfTokenFor } = await import('../src/auth.js');
    const csrf = csrfTokenFor(merchantCookie, config.sessionSecret);
    const [keys] = await pool.query("SELECT id FROM merchant_api_keys WHERE merchant_id = ? AND key_type = 'secret' AND status = 'active' ORDER BY created_at DESC LIMIT 1", [merchantId]);
    await req('POST', `/merchant/api-keys/${keys[0].id}/revoke`, { cookie: merchantCookie, body: form({ _csrf: csrf }), redirect: 'manual' });
    const denied = await req('POST', '/api/v1/orders', {
      headers: { Authorization: `Bearer ${secretKey}` },
      body: JSON.stringify({ merchant_order_id: 'ORDER-REVOKED', amount_paise: 1000 }),
    });
    assert.equal(denied.status, 401);

    // XSS: a business name containing a script tag must be escaped on pages.
    await pool.query('UPDATE merchants SET business_name = ? WHERE id = ?', ['<script>alert(1)</script>', merchantId]);
    const dash = await req('GET', '/merchant/dashboard', { cookie: merchantCookie });
    assert.doesNotMatch(dash.text, /<script>alert\(1\)<\/script>/);
    assert.match(dash.text, /&lt;script&gt;/);
  });
});
