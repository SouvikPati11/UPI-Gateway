import test, { describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Menu-button failure regressions (2026-10-26 report: tapping Menu did not
// open the navigation on Admin/Merchant panels).
//
// Root causes fixed and pinned here:
//  1. backdrop-filter on .topbar/.site-header created a containing block for
//     fixed-position descendants, so the fixed drawer was sized against the
//     ~60px header box instead of the viewport.
//  2. Author display rules on the drawer could override the closed
//     <details> hiding, so closed/open state was unreliable.
//  3. No backdrop, no scroll lock, no focus management.
// The fix: solid header backgrounds (no backdrop-filter), explicit
// closed-state hiding rules, a clickable backdrop, body scroll lock, and
// focus moves to the close button on open / back to Menu on Escape.
// Disposable test DB only:
//   GATEWAY_TEST_MYSQL=1 DB_HOST=localhost DB_PORT=3306 \
//   DB_USER=youpi_test DB_PASSWORD='<redacted>' \
//   DB_NAME=youpi_gateway_test npm test
const enabled = process.env.GATEWAY_TEST_MYSQL === '1'
  && Boolean(process.env.DB_HOST && process.env.DB_USER && process.env.DB_PASSWORD && process.env.DB_NAME);

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const gatewayRoot = path.resolve(__dirname, '..');

describe('Menu button fix: containing block, closed hiding, backdrop, lock, focus', { skip: !enabled }, () => {
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

  test('setup: installer, admin, approved merchant', async () => {
    const r = await req('POST', '/install', { body: form({
      db_host: process.env.DB_HOST, db_port: String(process.env.DB_PORT || 3306),
      db_name: process.env.DB_NAME, db_user: process.env.DB_USER, db_password: process.env.DB_PASSWORD,
      admin_name: 'Test Admin', admin_email: 'admin@example.test', admin_password: 'TestAdmin1234', admin_password_confirm: 'TestAdmin1234',
      confirm_empty_or_checked: 'yes',
    }) });
    assert.equal(r.status, 200, r.text.slice(0, 500));
    const adminLogin = await req('POST', '/admin/login', { body: form({ email: 'admin@example.test', password: 'TestAdmin1234' }), redirect: 'manual' });
    assert.ok(adminLogin.cookie);
    adminCookie = adminLogin.cookie;
    const { csrfTokenFor } = await import('../src/auth.js');
    const created = await req('POST', '/merchant/register', { body: form({ business_name: 'P5 Shop', contact_email: 'p5@example.test', password: 'ShopPass123', password_confirm: 'ShopPass123' }) });
    assert.equal(created.status, 200, created.text.slice(0, 300));
    const [m] = await pool.query('SELECT id FROM merchants WHERE contact_email = ?', ['p5@example.test']);
    const approve = await req('POST', `/admin/merchants/${m[0].id}/approve`, { cookie: adminCookie, body: form({ _csrf: csrfTokenFor(adminCookie, config.sessionSecret) }), redirect: 'manual' });
    assert.ok([200, 302].includes(approve.status));
    const login = await req('POST', '/merchant/login', { body: form({ email: 'p5@example.test', password: 'ShopPass123' }), redirect: 'manual' });
    assert.ok(login.cookie);
    merchantCookie = login.cookie;
  });

  test('no backdrop-filter anywhere: fixed drawers size against the viewport', async () => {
    const css = await req('GET', '/public/css/style.css?v=6');
    assert.equal(css.status, 200);
    assert.doesNotMatch(css.text, /backdrop-filter/, 'backdrop-filter creates a containing block for fixed descendants and squashes the drawer to header height');
    assert.match(css.text, /\.topbar\{[^}]*background:#fff/);
    assert.match(css.text, /\.site-header\{[^}]*background:#fff/);
  });

  test('explicit closed-state hiding for both drawers', async () => {
    const css = await req('GET', '/public/css/style.css?v=6');
    assert.match(css.text, /\.shell-menu:not\(\[open\]\) > nav\{display:none\}/);
    assert.match(css.text, /\.mobile-nav:not\(\[open\]\) \.mobile-nav-panel\{display:none\}/);
    assert.match(css.text, /\.shell-menu nav\{position:fixed;top:0;right:0;bottom:0;width:min\(88vw,320px\);z-index:100/);
    assert.match(css.text, /\.mobile-nav-panel\{position:fixed;top:0;left:0;bottom:0;width:min\(88vw,320px\)/);
  });

  test('admin AND merchant shells: menu button, drawer, backdrop, close, script wiring', async () => {
    for (const [page, cookie] of [['/admin/dashboard', adminCookie], ['/merchant/dashboard', merchantCookie]]) {
      const r = await req('GET', page, { cookie });
      assert.equal(r.status, 200, page);
      // Native <details>/<summary> toggle: no JS dependency for opening.
      assert.match(r.text, /<details class="shell-menu">/);
      assert.match(r.text, /<summary aria-label="Open navigation menu" aria-expanded="false">Menu<\/summary>/);
      // Drawer nav is a direct child of <details>, after the summary.
      assert.match(r.text, /<\/summary><nav aria-label="(Administrator|Merchant) navigation">/);
      // Visible close button inside the drawer.
      assert.match(r.text, /drawer-close" data-close-menu aria-label="Close menu">✕ Close/);
      // Clickable backdrop as a direct child of <details>, after </nav>.
      assert.match(r.text, /<\/nav><button type="button" class="drawer-backdrop" data-close-menu/);
      // Shared script: link-click close, Escape close + focus return, backdrop close, scroll lock, focus on open.
      assert.match(r.text, /syncDrawerLock/);
      assert.match(r.text, /no-scroll/);
      assert.match(r.text, /closest\('\[data-close-menu\]'\)/);
      assert.match(r.text, /if\(d\.open\)\{var c=nav\.querySelector\('\[data-close-menu\]'\)/);
      assert.match(r.text, /if\(e\.key==='Escape'&&d\.open\)\{close\(\);if\(summary\)summary\.focus\(\);/);
    }
  });

  test('public mobile menu: same backdrop + closed hiding', async () => {
    const home = await req('GET', '/');
    assert.equal(home.status, 200);
    assert.match(home.text, /<details class="mobile-nav">/);
    assert.match(home.text, /drawer-close dark" data-close-menu/);
    assert.match(home.text, /<\/div><button type="button" class="drawer-backdrop" data-close-menu/);
  });

  test('hero phone mock + admin View-all link (redesign gaps closed)', async () => {
    const home = await req('GET', '/');
    assert.match(home.text, /phone-mock/);
    assert.match(home.text, /Checkout preview — not a real payment code/);
    const ad = await req('GET', '/admin/dashboard', { cookie: adminCookie });
    assert.equal(ad.status, 200);
    assert.match(ad.text, /View all orders/);
  });

  test('stylesheet v6 serves; drawer geometry unchanged', async () => {
    const css = await req('GET', '/public/css/style.css?v=6');
    assert.equal(css.status, 200);
    assert.match(css.contentType || '', /text\/css/);
    assert.match(css.text, /\.drawer-backdrop\{position:fixed;inset:0;[^}]*z-index:99/);
    assert.match(css.text, /body\.no-scroll\{overflow:hidden\}/);
    const home = await req('GET', '/');
    assert.match(home.text, /style\.css\?v=6/);
  });
});
