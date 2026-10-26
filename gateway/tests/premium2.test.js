import test, { describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Premium-2 tests: simplified registration, auth pages, admin dashboard
// filters, merchant detail sections, merchant support, admin webhook retry.
// Run ONLY with a disposable test database, exactly like
// tests/integration.test.js. Otherwise skipped.
//   GATEWAY_TEST_MYSQL=1 DB_HOST=localhost DB_PORT=3306 \
//   DB_USER=youpi_test DB_PASSWORD='<redacted>' \
//   DB_NAME=youpi_gateway_test npm test
// The database is dropped and recreated here, so it must never be a
// production database.
const enabled = process.env.GATEWAY_TEST_MYSQL === '1'
  && Boolean(process.env.DB_HOST && process.env.DB_USER && process.env.DB_PASSWORD && process.env.DB_NAME);

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const gatewayRoot = path.resolve(__dirname, '..');

describe('Premium 2: simplified registration, auth pages, admin/merchant panels', { skip: !enabled }, () => {
  let pool;
  let server;
  let base;
  let config;
  let adminCookie;
  let merchantCookie;
  let merchant2Cookie;
  let merchantId;
  let merchant2Id;
  let simpleMerchantId;

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
    for (const table of ['support_messages', 'email_verifications', 'password_resets', 'merchant_subscriptions', 'subscription_plans', 'webhook_deliveries', 'order_events', 'verification_events', 'orders', 'merchant_api_keys', 'sessions', 'receiving_accounts', 'merchants', 'admins', 'audit_logs', 'app_settings', 'schema_migrations']) {
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

  test('setup: installer, two approved merchants', async () => {
    const r = await req('POST', '/install', { body: form({
      db_host: process.env.DB_HOST, db_port: String(process.env.DB_PORT || 3306),
      db_name: process.env.DB_NAME, db_user: process.env.DB_USER, db_password: process.env.DB_PASSWORD,
      admin_name: 'Test Admin', admin_email: 'admin@example.test', admin_password: 'TestAdmin1234', admin_password_confirm: 'TestAdmin1234',
      confirm_empty_or_checked: 'yes',
    }) });
    assert.equal(r.status, 200, r.text.slice(0, 500));
    await req('POST', '/merchant/register', { body: form({
      business_name: 'Panel Store One', slug: 'panel-one', contact_email: 'one@example.test',
      contact_phone: '9876543210', upi_id: 'one@okhdfc', payee_name: 'Panel One', password: 'MerchantPass123',
    }) });
    await req('POST', '/merchant/register', { body: form({
      business_name: 'Panel Store Two', slug: 'panel-two', contact_email: 'two@example.test',
      contact_phone: '9876543211', upi_id: 'two@okhdfc', payee_name: 'Panel Two', password: 'SecondPass123',
    }) });
    const login = await req('POST', '/merchant/login', { body: form({ email: 'one@example.test', password: 'MerchantPass123' }), redirect: 'manual' });
    assert.ok(login.cookie);
    merchantCookie = login.cookie;
    const login2 = await req('POST', '/merchant/login', { body: form({ email: 'two@example.test', password: 'SecondPass123' }), redirect: 'manual' });
    assert.ok(login2.cookie);
    merchant2Cookie = login2.cookie;
    const adminLogin = await req('POST', '/admin/login', { body: form({ email: 'admin@example.test', password: 'TestAdmin1234' }), redirect: 'manual' });
    assert.ok(adminLogin.cookie);
    adminCookie = adminLogin.cookie;
    const { csrfTokenFor } = await import('../src/auth.js');
    const [rows] = await pool.query('SELECT id FROM merchants WHERE slug = ?', ['panel-one']);
    merchantId = rows[0].id;
    const [rows2] = await pool.query('SELECT id FROM merchants WHERE slug = ?', ['panel-two']);
    merchant2Id = rows2[0].id;
    for (const id of [merchantId, merchant2Id]) {
      const approve = await req('POST', `/admin/merchants/${id}/approve`, { cookie: adminCookie, body: form({ _csrf: csrfTokenFor(adminCookie, config.sessionSecret) }), redirect: 'manual' });
      assert.ok([200, 302].includes(approve.status));
    }
  });

  test('simplified registration: only business, email, password + confirm', async () => {
    const formPage = await req('GET', '/merchant/register');
    assert.equal(formPage.status, 200);
    assert.doesNotMatch(formPage.text, /name="upi_id"/, 'registration form must not ask for UPI ID');
    assert.doesNotMatch(formPage.text, /name="slug"/, 'registration form must not ask for a slug');
    assert.doesNotMatch(formPage.text, /name="payee_name"/, 'registration form must not ask for payee name');
    assert.match(formPage.text, /Confirm password/);
    assert.match(formPage.text, /auth-shell/, 'registration must use the premium auth layout');
    const created = await req('POST', '/merchant/register', { body: form({
      business_name: 'Simple Shop', contact_email: 'simple@example.test',
      password: 'SimplePass123', password_confirm: 'SimplePass123',
    }) });
    assert.equal(created.status, 200, created.text.slice(0, 500));
    assert.match(created.text, /onboarding checklist/i);
    assert.match(created.text, /Configure your UPI ID/);
    const [rows] = await pool.query('SELECT * FROM merchants WHERE contact_email = ?', ['simple@example.test']);
    assert.equal(rows.length, 1);
    simpleMerchantId = rows[0].id;
    assert.equal(rows[0].status, 'pending');
    assert.equal(rows[0].upi_id, null, 'UPI ID must be null until onboarding completes it');
    assert.equal(rows[0].payee_name, null);
    assert.match(rows[0].slug, /^simple-shop/);
    const login = await req('POST', '/merchant/login', { body: form({ email: 'simple@example.test', password: 'SimplePass123' }), redirect: 'manual' });
    assert.ok(login.cookie, 'simplified registration must produce a working login');
  });

  test('registration rejects mismatched confirmation and duplicate email', async () => {
    const mismatch = await req('POST', '/merchant/register', { body: form({
      business_name: 'Mismatch Shop', contact_email: 'mismatch@example.test',
      password: 'MismatchPass123', password_confirm: 'DifferentPass123',
    }) });
    assert.equal(mismatch.status, 400);
    assert.match(mismatch.text, /do not match/);
    const dup = await req('POST', '/merchant/register', { body: form({
      business_name: 'Simple Shop Again', contact_email: 'simple@example.test',
      password: 'SimplePass123', password_confirm: 'SimplePass123',
    }) });
    assert.equal(dup.status, 400);
    assert.match(dup.text, /already exists/);
  });

  test('legacy full-field registration still works (backward compatibility)', async () => {
    const created = await req('POST', '/merchant/register', { body: form({
      business_name: 'Legacy Shop', slug: 'legacy-shop', contact_email: 'legacy@example.test',
      upi_id: 'legacy@okhdfc', payee_name: 'Legacy', password: 'LegacyPass123',
    }) });
    assert.equal(created.status, 200, created.text.slice(0, 500));
    const [rows] = await pool.query('SELECT slug, upi_id FROM merchants WHERE contact_email = ?', ['legacy@example.test']);
    assert.equal(rows[0].slug, 'legacy-shop');
    assert.equal(rows[0].upi_id, 'legacy@okhdfc');
  });

  test('auth pages use the split layout with real endpoints', async () => {
    for (const p of ['/merchant/login', '/merchant/register', '/admin/login']) {
      const r = await req('GET', p);
      assert.equal(r.status, 200, p);
      assert.match(r.text, /auth-shell/);
      assert.match(r.text, /auth-panel/);
    }
    const login = await req('GET', '/merchant/login');
    assert.match(login.text, /Forgot password\?/);
    assert.match(login.text, /Create an account/);
    assert.match(login.text, /pw-toggle|password/, 'auth script for show/hide password must be present');
  });

  test('homepage v2 has tour mockups, gradient headline and workflow', async () => {
    const home = await req('GET', '/');
    assert.equal(home.status, 200);
    assert.match(home.text, /grad-text/);
    assert.match(home.text, /id="tour"/);
    assert.match(home.text, /mock-qr/);
    assert.match(home.text, /Illustrative QR pattern/);
    assert.match(home.text, /id="workflow"/);
    assert.match(home.text, /payment verification/i);
    assert.doesNotMatch(home.text, /10,000\+ merchants|trusted by millions/i);
  });

  test('admin dashboard: date filter, subscription stats, recent events', async () => {
    const dash = await req('GET', '/admin/dashboard', { cookie: adminCookie });
    assert.equal(dash.status, 200, dash.text.slice(0, 500));
    assert.match(dash.text, /Subscriptions/);
    assert.match(dash.text, /Recent operational events/);
    assert.match(dash.text, /name="from"/);
    const filtered = await req('GET', '/admin/dashboard?from=2026-01-01&to=2026-12-31', { cookie: adminCookie });
    assert.equal(filtered.status, 200);
    assert.match(filtered.text, /Showing: 2026-01-01 to 2026-12-31/);
    const badDate = await req('GET', '/admin/dashboard?from=2026-02-30&to=not-a-date', { cookie: adminCookie });
    assert.equal(badDate.status, 200, 'an invalid filter date must degrade to all time, not error');
    assert.match(badDate.text, /Showing: all time/);
    const injection = await req('GET', "/admin/dashboard?from=2026-01-01' OR '1'='1", { cookie: adminCookie });
    assert.equal(injection.status, 200);
    assert.match(injection.text, /Showing: all time/, 'a non-date filter value must be ignored, never interpolated');
  });

  test('admin merchant detail shows subscriptions, usage and webhook deliveries', async () => {
    const detail = await req('GET', `/admin/merchants/${merchantId}`, { cookie: adminCookie });
    assert.equal(detail.status, 200, detail.text.slice(0, 500));
    assert.match(detail.text, /Subscriptions/);
    assert.match(detail.text, /Usage this month/);
    assert.match(detail.text, /Webhook deliveries/);
    assert.doesNotMatch(detail.text, /webhook_secret_encrypted|sk_[A-Za-z0-9]/, 'detail page must never leak secrets');
  });

  test('merchant support: create, admin reply visible, isolation holds', async () => {
    const { csrfTokenFor } = await import('../src/auth.js');
    const created = await req('POST', '/merchant/support', { cookie: merchantCookie, body: form({ _csrf: csrfTokenFor(merchantCookie, config.sessionSecret), subject: 'Payout question', message: 'When is my plan verified?' }), redirect: 'manual' });
    assert.ok([200, 302].includes(created.status), created.text.slice(0, 500));
    const mine = await req('GET', '/merchant/support', { cookie: merchantCookie });
    assert.equal(mine.status, 200);
    assert.match(mine.text, /Payout question/);
    const [msgs] = await pool.query('SELECT id FROM support_messages WHERE subject = ?', ['Payout question']);
    assert.equal(msgs.length, 1);
    const reply = await req('POST', `/admin/support/${msgs[0].id}/reply`, { cookie: adminCookie, body: form({ _csrf: csrfTokenFor(adminCookie, config.sessionSecret), admin_reply: 'Your plan is verified after manual billing.', status: 'answered' }), redirect: 'manual' });
    assert.ok([200, 302].includes(reply.status));
    const mineAfter = await req('GET', '/merchant/support', { cookie: merchantCookie });
    assert.match(mineAfter.text, /Your plan is verified after manual billing/);
    const other = await req('GET', '/merchant/support', { cookie: merchant2Cookie });
    assert.equal(other.status, 200);
    assert.doesNotMatch(other.text, /Payout question/, 'a second merchant must not see the first merchant support messages');
    const bad = await req('POST', '/merchant/support', { cookie: merchantCookie, body: form({ _csrf: csrfTokenFor(merchantCookie, config.sessionSecret), subject: '', message: '' }) });
    assert.equal(bad.status, 400);
  });

  test('admin webhook retry works and is audited; dead cron form is gone', async () => {
    const page = await req('GET', '/admin/webhooks', { cookie: adminCookie });
    assert.equal(page.status, 200);
    assert.doesNotMatch(page.text, /action="\/cron\/webhooks"/, 'the nonfunctional cron form must be gone');
    const { randomUUID } = await import('node:crypto');
    const deliveryId = randomUUID();
    await pool.query('INSERT INTO webhook_deliveries (id, merchant_id, order_id, event_type, endpoint_url, delivery_id, payload, response_status, attempt_count, is_successful, next_retry_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [deliveryId, merchantId, null, 'order.success', 'http://127.0.0.1:1/hook', `dl-${deliveryId.slice(0, 8)}`, '{}', null, 1, 0, new Date('2020-01-01')]);
    const { csrfTokenFor } = await import('../src/auth.js');
    const retried = await req('POST', `/admin/webhooks/${deliveryId}/retry`, { cookie: adminCookie, body: form({ _csrf: csrfTokenFor(adminCookie, config.sessionSecret) }), redirect: 'manual' });
    assert.ok([200, 302].includes(retried.status), retried.text.slice(0, 500));
    const [after] = await pool.query('SELECT next_retry_at FROM webhook_deliveries WHERE id = ?', [deliveryId]);
    assert.ok(after[0].next_retry_at, 'retry must schedule the delivery');
    const [auditRows] = await pool.query("SELECT * FROM audit_logs WHERE action = 'webhook_retry_admin' AND entity_id = ?", [deliveryId]);
    assert.equal(auditRows.length, 1, 'admin retry must be audited');
    // A merchant cannot use the admin retry route.
    const forbidden = await req('POST', `/admin/webhooks/${deliveryId}/retry`, { cookie: merchantCookie, body: form({ _csrf: csrfTokenFor(merchantCookie, config.sessionSecret) }), redirect: 'manual' });
    assert.equal(forbidden.status, 302, 'admin routes must redirect unauthenticated/merchant sessions to login');
    assert.match(forbidden.location || '', /admin\/login/);
  });

  test('logout ends the merchant session', async () => {
    const out = await req('GET', '/merchant/logout', { cookie: merchantCookie, redirect: 'manual' });
    assert.ok([200, 302].includes(out.status));
    const dash = await req('GET', '/merchant/dashboard', { cookie: merchantCookie, redirect: 'manual' });
    assert.equal(dash.status, 302, 'a logged-out session must no longer open the dashboard');
    assert.match(dash.location || '', /merchant\/login/);
  });
});
