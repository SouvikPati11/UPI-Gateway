import test, { describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Reference-image redesign regressions: hero pills + preview, workflow
// icons/titles, white sidebar with icons + active marking script, functional
// topbar search, dark public mobile drawer, stat cards, stacked trend chart
// with prior-period line, docs steps list. Disposable test DB only:
//   GATEWAY_TEST_MYSQL=1 DB_HOST=localhost DB_PORT=3306 \
//   DB_USER=youpi_test DB_PASSWORD='<redacted>' \
//   DB_NAME=youpi_gateway_test npm test
const enabled = process.env.GATEWAY_TEST_MYSQL === '1'
  && Boolean(process.env.DB_HOST && process.env.DB_USER && process.env.DB_PASSWORD && process.env.DB_NAME);

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const gatewayRoot = path.resolve(__dirname, '..');

describe('Reference redesign: hero, sidebar, search, stat cards, stacked chart', { skip: !enabled }, () => {
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

  test('setup: installer, admin, approved merchant with orders', async () => {
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
    const created = await req('POST', '/merchant/register', { body: form({ business_name: 'P4 Shop', contact_email: 'p4@example.test', password: 'ShopPass123', password_confirm: 'ShopPass123' }) });
    assert.equal(created.status, 200, created.text.slice(0, 300));
    const [m] = await pool.query('SELECT id FROM merchants WHERE contact_email = ?', ['p4@example.test']);
    const approve = await req('POST', `/admin/merchants/${m[0].id}/approve`, { cookie: adminCookie, body: form({ _csrf: csrfTokenFor(adminCookie, config.sessionSecret) }), redirect: 'manual' });
    assert.ok([200, 302].includes(approve.status));
    const login = await req('POST', '/merchant/login', { body: form({ email: 'p4@example.test', password: 'ShopPass123' }), redirect: 'manual' });
    assert.ok(login.cookie);
    merchantCookie = login.cookie;
    const profile = await req('POST', '/merchant/profile', { cookie: merchantCookie, body: form({ _csrf: csrfTokenFor(merchantCookie, config.sessionSecret), business_name: 'P4 Shop', contact_email: 'p4@example.test', contact_phone: '', upi_id: 'p4@okhdfc', payee_name: 'P4' }), redirect: 'manual' });
    assert.ok([200, 302].includes(profile.status), profile.text.slice(0, 300));
    const order = await req('POST', '/merchant/orders', { cookie: merchantCookie, body: form({ _csrf: csrfTokenFor(merchantCookie, config.sessionSecret), amount_rupees: '499.00', merchant_order_id: 'P4-001', mode: 'sandbox' }), redirect: 'manual' });
    assert.ok([200, 302].includes(order.status), order.text.slice(0, 300));
  });

  test('hero: reference headline, pills, demo CTAs, preview tiles', async () => {
    const home = await req('GET', '/');
    assert.equal(home.status, 200);
    assert.match(home.text, /Accept UPI Payments/);
    assert.match(home.text, /for Your Business/);
    assert.match(home.text, /Secure Payments/);
    assert.match(home.text, /Developer Friendly/);
    assert.match(home.text, /Get Started Free/);
    assert.match(home.text, /href="\/#tour">View Demo/);
    assert.match(home.text, /preview-tiles/);
    assert.match(home.text, /Illustrative preview of the dashboard layout — not live data/);
    assert.doesNotMatch(home.text, /₹48,920|1,248 orders|₹12,450/);
  });

  test('workflow: five reference-titled steps with icons', async () => {
    const home = await req('GET', '/');
    for (const title of ['Create Order', 'Share Payment Link', 'Customer Pays', 'Verification', 'Get Confirmed']) {
      assert.match(home.text, new RegExp(`<h3>${title}</h3>`), `missing workflow step ${title}`);
    }
    assert.match(home.text, /step-icon/);
    assert.match(home.text, /never proves payment on its own/);
  });

  test('shells: white sidebar icons, topbar search, active-marking script', async () => {
    for (const [page, cookie, searchAction] of [
      ['/admin/dashboard', adminCookie, '/admin/orders'],
      ['/merchant/dashboard', merchantCookie, '/merchant/orders'],
    ]) {
      const r = await req('GET', page, { cookie });
      assert.equal(r.status, 200, page);
      assert.match(r.text, /<aside class="sidebar"/);
      assert.match(r.text, /nav-ico/);
      assert.match(r.text, new RegExp(`action="${searchAction.replace(/\//g, '\\/')}"`));
      assert.match(r.text, /Search merchants, orders/);
      assert.match(r.text, /classList\.add\('active'\)/);
      assert.match(r.text, /shell-menu/);
      assert.match(r.text, /data-close-menu/);
    }
    const css = await req('GET', '/public/css/style.css?v=6');
    assert.match(css.text, /\.sidebar\{[^}]*background:#fff/);
    assert.match(css.text, /\.sidebar-nav a\.active\{[^}]*linear-gradient\(135deg,#6366f1,#7c3aed\)/);
  });

  test('topbar search actually filters (no decorative control)', async () => {
    const r = await req('GET', '/merchant/orders?q=P4-001', { cookie: merchantCookie });
    assert.equal(r.status, 200);
    assert.match(r.text, /P4-001/);
    const ad = await req('GET', '/admin/orders?q=P4-001', { cookie: adminCookie });
    assert.equal(ad.status, 200);
    assert.match(ad.text, /P4-001/);
  });

  test('dark public mobile drawer CSS', async () => {
    const css = await req('GET', '/public/css/style.css?v=6');
    assert.equal(css.status, 200);
    assert.match(css.text, /\.mobile-nav-panel\{position:fixed;top:0;left:0;bottom:0;width:min\(88vw,320px\);background:#0b1220/);
    const home = await req('GET', '/');
    assert.match(home.text, /drawer-close dark/);
  });

  test('dashboards: stat cards, stacked chart legend, prior-period line', async () => {
    for (const [page, cookie] of [['/admin/dashboard', adminCookie], ['/merchant/dashboard', merchantCookie]]) {
      const r = await req('GET', page, { cookie });
      assert.equal(r.status, 200, page);
      assert.match(r.text, /stat-card/);
      assert.match(r.text, /stat-ico/);
      assert.match(r.text, /Total revenue/);
      assert.match(r.text, /success rate|Successful orders only/);
      assert.match(r.text, /Orders per day — last 14 days/);
      assert.match(r.text, /<svg viewBox="0 0 560 156"/);
      assert.match(r.text, /<i class="sw amber"><\/i>Pending/);
      assert.match(r.text, /<i class="sw red"><\/i>Failed/);
      assert.match(r.text, /<i class="sw grey"><\/i>Other/);
      assert.match(r.text, /Prior 14 days/);
      assert.match(r.text, /Source: orders table, last 14 days/);
    }
  });

  test('docs: numbered steps list; stylesheet v5 serves', async () => {
    const d = await req('GET', '/merchant/docs', { cookie: merchantCookie });
    assert.equal(d.status, 200);
    assert.match(d.text, /class="steps-list"/);
    assert.match(d.text, /Integration in 6 steps/);
    const css = await req('GET', '/public/css/style.css?v=6');
    assert.equal(css.status, 200);
    assert.match(css.contentType || '', /text\/css/);
    assert.match(css.text, /\.steps-list li::before/);
    assert.match(css.text, /width:min\(88vw,320px\)/);
  });
});
