import test, { describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Regression tests for the mobile navigation drawer defect: the old
// absolutely-positioned panel was sized against the ~85px-wide Menu
// button, producing a ~53px narrow strip that overlapped page content.
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

describe('Mobile navigation drawer and dashboard polish', { skip: !enabled }, () => {
  let pool;
  let server;
  let base;
  let config;
  let adminCookie;
  let merchantCookie;

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

  async function req(method, urlPath, { body, cookie, redirect = 'follow' } = {}) {
    let payload = null;
    const h = {};
    if (body) { payload = new URLSearchParams(body).toString(); h['Content-Type'] = 'application/x-www-form-urlencoded'; }
    if (cookie) h.Cookie = `gw_session=${encodeURIComponent(cookie)}`;
    const res = await fetch(`${base}${urlPath}`, { method, headers: h, body: payload, redirect });
    const text = await res.text();
    return { status: res.status, text, cookie: cookieFrom(res), location: res.headers.get('location'), contentType: res.headers.get('content-type') };
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

  test('setup: installer, approved merchant with one sandbox order, admin', async () => {
    const r = await req('POST', '/install', { body: form({
      db_host: process.env.DB_HOST, db_port: String(process.env.DB_PORT || 3306),
      db_name: process.env.DB_NAME, db_user: process.env.DB_USER, db_password: process.env.DB_PASSWORD,
      admin_name: 'Test Admin', admin_email: 'admin@example.test', admin_password: 'TestAdmin1234', admin_password_confirm: 'TestAdmin1234',
      confirm_empty_or_checked: 'yes',
    }) });
    assert.equal(r.status, 200, r.text.slice(0, 500));
    const created = await req('POST', '/merchant/register', { body: form({ business_name: 'Drawer Shop', contact_email: 'drawer@example.test', password: 'DrawerPass123', password_confirm: 'DrawerPass123' }) });
    assert.equal(created.status, 200, created.text.slice(0, 500));
    const adminLogin = await req('POST', '/admin/login', { body: form({ email: 'admin@example.test', password: 'TestAdmin1234' }), redirect: 'manual' });
    assert.ok(adminLogin.cookie);
    adminCookie = adminLogin.cookie;
    const { csrfTokenFor } = await import('../src/auth.js');
    const [m] = await pool.query('SELECT id FROM merchants WHERE contact_email = ?', ['drawer@example.test']);
    const approve = await req('POST', `/admin/merchants/${m[0].id}/approve`, { cookie: adminCookie, body: form({ _csrf: csrfTokenFor(adminCookie, config.sessionSecret) }), redirect: 'manual' });
    assert.ok([200, 302].includes(approve.status));
    const login = await req('POST', '/merchant/login', { body: form({ email: 'drawer@example.test', password: 'DrawerPass123' }), redirect: 'manual' });
    assert.ok(login.cookie);
    merchantCookie = login.cookie;
    const profile = await req('POST', '/merchant/profile', { cookie: merchantCookie, body: form({ _csrf: csrfTokenFor(merchantCookie, config.sessionSecret), business_name: 'Drawer Shop', contact_email: 'drawer@example.test', contact_phone: '', upi_id: 'drawer@okhdfc', payee_name: 'Drawer' }), redirect: 'manual' });
    assert.ok([200, 302].includes(profile.status), profile.text.slice(0, 500));
    const order = await req('POST', '/merchant/orders', { cookie: merchantCookie, body: form({ _csrf: csrfTokenFor(merchantCookie, config.sessionSecret), amount_rupees: '249.00', merchant_order_id: 'DRAWER-001', mode: 'sandbox' }), redirect: 'manual' });
    assert.ok([200, 302].includes(order.status), order.text.slice(0, 500));
  });

  test('drawer CSS: fixed panel at min(88vw,320px), no narrow-strip rule', async () => {
    const css = await req('GET', '/public/css/style.css?v=3');
    assert.equal(css.status, 200);
    assert.match(css.contentType || '', /text\/css/, 'stylesheet must serve with a CSS MIME type');
    assert.match(css.text, /\.shell-menu nav\{[^}]*position:fixed/, 'drawer panel must be fixed to the viewport');
    assert.match(css.text, /width:min\(88vw,320px\)/, 'drawer width must be min(88vw, 320px)');
    assert.doesNotMatch(css.text, /\.shell-menu nav\{[^}]*position:absolute/, 'the old absolute panel rule must be gone');
    assert.doesNotMatch(css.text, /\.shell-menu\{display:block;position:relative\}/, 'the drawer must not be positioned against the tiny Menu button');
    assert.match(css.text, /\.drawer-close/, 'a visible close control must be styled');
    assert.match(css.text, /@media\(max-width:720px\)/);
    assert.match(css.text, /@media\(max-width:1024px\)/);
  });

  test('shell markup: drawer, close button, close-on-link and Escape handlers', async () => {
    for (const [page, cookie] of [['/admin/dashboard', adminCookie], ['/merchant/dashboard', merchantCookie]]) {
      const r = await req('GET', page, { cookie });
      assert.equal(r.status, 200, page);
      assert.match(r.text, /<details class="shell-menu"/, `${page} must render the drawer toggle`);
      assert.match(r.text, /data-close-menu/, `${page} must render a close control`);
      assert.match(r.text, /aria-label="Close menu"/);
      assert.match(r.text, /Escape/, `${page} must include the Escape-to-close handler`);
      assert.match(r.text, /<aside class="sidebar"/, 'desktop sidebar must be preserved');
    }
  });

  test('stylesheet link is versioned so stale CSS cannot persist after redeploy', async () => {
    const home = await req('GET', '/');
    assert.match(home.text, /style\.css\?v=/, 'stylesheet link must carry a version query to bust caches');
    const css = await req('GET', '/public/css/style.css?v=3');
    assert.equal(css.status, 200);
  });

  test('dashboards show real-data status bars, not fabricated charts', async () => {
    const md = await req('GET', '/merchant/dashboard', { cookie: merchantCookie });
    assert.equal(md.status, 200);
    assert.match(md.text, /Orders by status/);
    assert.match(md.text, /status-bar-row/);
    assert.match(md.text, /DRAWER-001|249\.00/);
    const ad = await req('GET', '/admin/dashboard', { cookie: adminCookie });
    assert.equal(ad.status, 200);
    assert.match(ad.text, /Orders by status/);
    assert.match(ad.text, /status-bar-row/);
    assert.doesNotMatch(ad.text, /<canvas/, 'no chart canvas may appear without real chart data wiring');
  });

  test('public mobile nav is a proper drawer (no narrow strip there either)', async () => {
    const css = await req('GET', '/public/css/style.css?v=3');
    assert.match(css.text, /\.mobile-nav-panel\{position:fixed;top:0;left:0;bottom:0;width:min\(88vw,320px\)/, 'public mobile panel must be a fixed dark drawer, not a thin strip');
    assert.match(css.text, /\.mobile-nav-panel\{[^}]*background:#0b1220/);
    const home = await req('GET', '/');
    assert.match(home.text, /mobile-nav/);
    assert.match(home.text, /drawer-close dark/);
  });
});
