import test, { describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// New-feature integration tests — run ONLY with a disposable test
// database, exactly like tests/integration.test.js. Otherwise skipped.
//   GATEWAY_TEST_MYSQL=1 DB_HOST=localhost DB_PORT=3306 \
//   DB_USER=youpi_test DB_PASSWORD='<test only>' \
//   DB_NAME=youpi_gateway_test npm test
// The database is dropped and recreated here, so it must never be a
// production database.
const enabled = process.env.GATEWAY_TEST_MYSQL === '1'
  && Boolean(process.env.DB_HOST && process.env.DB_USER && process.env.DB_PASSWORD && process.env.DB_NAME);

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const gatewayRoot = path.resolve(__dirname, '..');

describe('Merchant dashboard orders, admin refund, API currency/return validation', { skip: !enabled }, () => {
  let pool;
  let server;
  let base;
  let config;
  let adminCookie;
  let merchantCookie;
  let secretKey;
  let merchantId;
  let dashboardRef;
  let apiRef;
  let refundRef;

  function cookieFrom(res) {
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
    delete process.env.PROVIDER_WEBHOOK_SECRET;
    delete process.env.OBSERVER_API_TOKEN;
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
    assert.deepEqual(results.map((r) => r.status), ['applied', 'applied', 'applied']);
    const { createApp } = await import('../src/app.js');
    const app = createApp({ config, pool });
    await new Promise((resolve) => { server = app.listen(0, '127.0.0.1', resolve); });
    base = `http://127.0.0.1:${server.address().port}`;
  });

  after(async () => {
    if (server) await new Promise((resolve) => server.close(resolve));
    if (pool) await pool.end();
    const envPath = path.join(gatewayRoot, '.env');
    try { if (fs.existsSync(envPath)) fs.unlinkSync(envPath); } catch {}
  });

  test('installer, merchant registration and admin approval', async () => {
    const r = await req('POST', '/install', { body: form({
      db_host: process.env.DB_HOST, db_port: String(process.env.DB_PORT || 3306),
      db_name: process.env.DB_NAME, db_user: process.env.DB_USER, db_password: process.env.DB_PASSWORD,
      admin_name: 'Test Admin', admin_email: 'admin@example.test', admin_password: 'TestAdmin1234', admin_password_confirm: 'TestAdmin1234',
      confirm_empty_or_checked: 'yes',
    }) });
    assert.equal(r.status, 200, r.text.slice(0, 500));
    assert.match(r.text, /Installation complete/);
    await req('POST', '/merchant/register', { body: form({
      business_name: 'Acme Test Store', slug: 'acme-test', contact_email: 'acme@example.test',
      contact_phone: '9876543210', upi_id: 'acme@okhdfc', payee_name: 'Acme Test', password: 'MerchantPass123',
    }) });
    const login = await req('POST', '/merchant/login', { body: form({ email: 'acme@example.test', password: 'MerchantPass123' }), redirect: 'manual' });
    assert.ok(login.cookie);
    merchantCookie = login.cookie;
    const adminLogin = await req('POST', '/admin/login', { body: form({ email: 'admin@example.test', password: 'TestAdmin1234' }), redirect: 'manual' });
    assert.ok(adminLogin.cookie);
    adminCookie = adminLogin.cookie;
    const [rows] = await pool.query('SELECT id FROM merchants WHERE slug = ?', ['acme-test']);
    merchantId = rows[0].id;
    const { csrfTokenFor } = await import('../src/auth.js');
    const approve = await req('POST', `/admin/merchants/${merchantId}/approve`, { cookie: adminCookie, body: form({ _csrf: csrfTokenFor(adminCookie, config.sessionSecret) }), redirect: 'manual' });
    assert.ok([200, 302].includes(approve.status));
    const [m] = await pool.query('SELECT status FROM merchants WHERE id = ?', [merchantId]);
    assert.equal(m[0].status, 'approved');
    const { csrfTokenFor: csrfFor } = await import('../src/auth.js');
    const created = await req('POST', '/merchant/api-keys', { cookie: merchantCookie, body: form({ _csrf: csrfFor(merchantCookie, config.sessionSecret), name: 'Website', key_type: 'secret' }), redirect: 'manual' });
    assert.equal(created.status, 302);
    secretKey = new URL(created.location, base).searchParams.get('new_key');
    assert.ok(secretKey && secretKey.startsWith('sk_'));
  });

  test('merchant dashboard creates a payment link with QR checkout', async () => {
    const { csrfTokenFor } = await import('../src/auth.js');
    const csrf = csrfTokenFor(merchantCookie, config.sessionSecret);
    const formPage = await req('GET', '/merchant/orders/new', { cookie: merchantCookie });
    assert.equal(formPage.status, 200);
    assert.match(formPage.text, /Create payment link/);
    const created = await req('POST', '/merchant/orders', {
      cookie: merchantCookie,
      body: form({ _csrf: csrf, merchant_order_id: '', amount_rupees: '250.00', customer_name: 'Dashboard Buyer', return_url: 'https://merchant.example.test/thank-you', mode: 'live' }),
      redirect: 'manual',
    });
    assert.ok([200, 302].includes(created.status), created.text.slice(0, 500));
    assert.ok(created.location && created.location.startsWith('/merchant/orders/'), created.location);
    dashboardRef = created.location.split('/').pop();
    const [rows] = await pool.query('SELECT * FROM orders WHERE gateway_reference = ?', [dashboardRef]);
    assert.equal(rows[0].status, 'pending');
    assert.equal(Number(rows[0].amount_paise), 25000);
    assert.equal(rows[0].currency, 'INR');
    assert.equal(rows[0].return_url, 'https://merchant.example.test/thank-you');
    assert.match(rows[0].merchant_order_id, /^WEB-/);
    const checkout = await req('GET', `/checkout/${dashboardRef}`);
    assert.equal(checkout.status, 200);
    assert.match(checkout.text, /data:image\/png/);
    assert.match(checkout.text, /am=250\.00/);
    assert.match(checkout.text, /Return to merchant/);
  });

  test('merchant dashboard order creation validates amount, return URL and duplicates', async () => {
    const { csrfTokenFor } = await import('../src/auth.js');
    const csrf = csrfTokenFor(merchantCookie, config.sessionSecret);
    const badAmount = await req('POST', '/merchant/orders', { cookie: merchantCookie, body: form({ _csrf: csrf, amount_rupees: '0' }) });
    assert.equal(badAmount.status, 400);
    const badUrl = await req('POST', '/merchant/orders', { cookie: merchantCookie, body: form({ _csrf: csrf, amount_rupees: '10.00', return_url: 'javascript:alert(1)' }) });
    assert.equal(badUrl.status, 400);
    const first = await req('POST', '/merchant/orders', { cookie: merchantCookie, body: form({ _csrf: csrf, merchant_order_id: 'DASH-1', amount_rupees: '10.00' }), redirect: 'manual' });
    assert.ok([200, 302].includes(first.status));
    const dup = await req('POST', '/merchant/orders', { cookie: merchantCookie, body: form({ _csrf: csrf, merchant_order_id: 'DASH-1', amount_rupees: '10.00' }) });
    assert.equal(dup.status, 409);
  });

  test('API rejects non-INR currency and javascript return URLs, accepts INR', async () => {
    const usd = await req('POST', '/api/v1/orders', { headers: { Authorization: `Bearer ${secretKey}` }, body: JSON.stringify({ merchant_order_id: 'API-USD', amount_paise: 10000, currency: 'USD' }) });
    assert.equal(usd.status, 400);
    assert.match(usd.text, /Only INR/);
    const badUrl = await req('POST', '/api/v1/orders', { headers: { Authorization: `Bearer ${secretKey}` }, body: JSON.stringify({ merchant_order_id: 'API-BADURL', amount_paise: 10000, return_url: 'javascript:alert(1)' }) });
    assert.equal(badUrl.status, 400);
    const ok = await req('POST', '/api/v1/orders', { headers: { Authorization: `Bearer ${secretKey}` }, body: JSON.stringify({ merchant_order_id: 'API-OK', amount_paise: 10000, currency: 'INR', return_url: 'https://merchant.example.test/ok' }) });
    assert.equal(ok.status, 201, ok.text.slice(0, 500));
    apiRef = ok.json.order.gateway_reference;
    const [rows] = await pool.query('SELECT * FROM orders WHERE merchant_order_id = ?', ['API-USD']);
    assert.equal(rows.length, 0, 'a rejected USD order must not be created');
  });

  test('admin refund moves a successful order to refunded and blocks pending refunds', async () => {
    const { csrfTokenFor } = await import('../src/auth.js');
    const created = await req('POST', '/api/v1/orders', { headers: { Authorization: `Bearer ${secretKey}` }, body: JSON.stringify({ merchant_order_id: 'API-REFUND', amount_paise: 5000 }) });
    assert.equal(created.status, 201);
    refundRef = created.json.order.gateway_reference;
    await req('POST', `/checkout/${refundRef}/paid`, { redirect: 'manual' });
    const adminCsrf = csrfTokenFor(adminCookie, config.sessionSecret);
    const verified = await req('POST', `/admin/verify/${refundRef}/success`, { cookie: adminCookie, body: form({ _csrf: adminCsrf, utr: '987654321098' }), redirect: 'manual' });
    assert.ok([200, 302].includes(verified.status));
    const detail = await req('GET', `/admin/orders/${refundRef}`, { cookie: adminCookie });
    assert.match(detail.text, /Record a refund/);
    const refunded = await req('POST', `/admin/orders/${refundRef}/refund`, { cookie: adminCookie, body: form({ _csrf: adminCsrf, refund_reason: 'Customer asked for a refund' }), redirect: 'manual' });
    assert.ok([200, 302].includes(refunded.status), refunded.text.slice(0, 500));
    const [rows] = await pool.query('SELECT status FROM orders WHERE gateway_reference = ?', [refundRef]);
    assert.equal(rows[0].status, 'refunded');
    const [events] = await pool.query("SELECT * FROM order_events WHERE order_id = (SELECT id FROM orders WHERE gateway_reference = ?) AND event_type = 'order_refunded'", [refundRef]);
    assert.equal(events.length, 1);
    // A pending order cannot be refunded.
    const pendingRefund = await req('POST', `/admin/orders/${apiRef}/refund`, { cookie: adminCookie, body: form({ _csrf: adminCsrf }) });
    assert.equal(pendingRefund.status, 409);
  });

  test('admin settings cannot save provider mode without a provider secret, and UTR search works', async () => {
    const { csrfTokenFor } = await import('../src/auth.js');
    const csrf = csrfTokenFor(adminCookie, config.sessionSecret);
    const settingsPage = await req('GET', '/admin/settings', { cookie: adminCookie });
    assert.match(settingsPage.text, /Effective verification mode/);
    assert.match(settingsPage.text, /manual/);
    const badSave = await req('POST', '/admin/settings', { cookie: adminCookie, body: form({ _csrf: csrf, app_name: 'YOUPI PG', verification_mode: 'provider' }) });
    assert.equal(badSave.status, 400);
    assert.match(badSave.text, /PROVIDER_WEBHOOK_SECRET/);
    const [settings] = await pool.query("SELECT setting_value FROM app_settings WHERE setting_key = 'verification_mode'");
    if (settings[0]) {
      const v = typeof settings[0].setting_value === 'string' ? JSON.parse(settings[0].setting_value) : settings[0].setting_value;
      assert.notEqual(v.value, 'provider');
    }
    const adminSearch = await req('GET', '/admin/orders?q=987654321098', { cookie: adminCookie });
    assert.match(adminSearch.text, new RegExp(refundRef));
    const merchantSearch = await req('GET', '/merchant/orders?q=987654321098', { cookie: merchantCookie });
    assert.match(merchantSearch.text, new RegExp(refundRef));
  });
});
