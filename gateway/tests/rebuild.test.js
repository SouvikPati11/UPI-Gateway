import test, { describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Rebuild E2E tests: merchant login/session/dashboard, admin panel,
// navigation crawl, isolation, rate-limit UX, layout/assets, and the
// pre-004 (older database) degraded mode.
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

describe('Rebuild E2E: login, dashboard, admin panel, layout', { skip: !enabled }, () => {
  let pool;
  let server;
  let base;
  let config;
  let adminCookie;
  let merchantCookie;
  let merchant2Cookie;
  let merchantId;
  let merchant2Id;
  let orderRef;

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
      if (body instanceof URLSearchParams) { payload = body.toString(); h['Content-Type'] = 'application/x-www-form-urlencoded'; }
      else { payload = new URLSearchParams(body).toString(); h['Content-Type'] = 'application/x-www-form-urlencoded'; }
    }
    if (cookie) h.Cookie = `gw_session=${encodeURIComponent(cookie)}`;
    const res = await fetch(`${base}${urlPath}`, { method, headers: h, body: payload, redirect });
    const text = await res.text();
    return { status: res.status, text, cookie: cookieFrom(res), location: res.headers.get('location') };
  }

  function form(obj) { return new URLSearchParams(obj); }

  function navHrefs(html, prefix) {
    const out = new Set();
    for (const m of html.matchAll(/href="(\/[^"#?]+)"/g)) {
      if (m[1].startsWith(prefix)) out.add(m[1]);
    }
    return [...out];
  }

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

  test('setup: installer, merchants, admin, one order', async () => {
    const r = await req('POST', '/install', { body: form({
      db_host: process.env.DB_HOST, db_port: String(process.env.DB_PORT || 3306),
      db_name: process.env.DB_NAME, db_user: process.env.DB_USER, db_password: process.env.DB_PASSWORD,
      admin_name: 'Test Admin', admin_email: 'admin@example.test', admin_password: 'TestAdmin1234', admin_password_confirm: 'TestAdmin1234',
      confirm_empty_or_checked: 'yes',
    }) });
    assert.equal(r.status, 200, r.text.slice(0, 500));
    for (const [name, slug, email, pass] of [
      ['Rebuild Store With A Very Long Business Name That Must Wrap Nicely On Small Screens Without Clipping', 'rebuild-one', 'rebuild1@example.test', 'RebuildPass123'],
      ['Rebuild Store Two', 'rebuild-two', 'rebuild2@example.test', 'RebuildPass456'],
    ]) {
      const created = await req('POST', '/merchant/register', { body: form({ business_name: name, contact_email: email, password: pass, password_confirm: pass }) });
      assert.equal(created.status, 200, created.text.slice(0, 500));
    }
    // Simplified registration auto-generates the slug from the business
    // name, so look merchants up by email, not by an assumed slug.
    const [m1] = await pool.query('SELECT id FROM merchants WHERE contact_email = ?', ['rebuild1@example.test']);
    const [m2] = await pool.query('SELECT id FROM merchants WHERE contact_email = ?', ['rebuild2@example.test']);
    merchantId = m1[0].id; merchant2Id = m2[0].id;
    const adminLogin = await req('POST', '/admin/login', { body: form({ email: 'admin@example.test', password: 'TestAdmin1234' }), redirect: 'manual' });
    assert.ok(adminLogin.cookie);
    adminCookie = adminLogin.cookie;
    const { csrfTokenFor } = await import('../src/auth.js');
    for (const id of [merchantId, merchant2Id]) {
      const approve = await req('POST', `/admin/merchants/${id}/approve`, { cookie: adminCookie, body: form({ _csrf: csrfTokenFor(adminCookie, config.sessionSecret) }), redirect: 'manual' });
      assert.ok([200, 302].includes(approve.status));
    }
    const login = await req('POST', '/merchant/login', { body: form({ email: 'rebuild1@example.test', password: 'RebuildPass123' }), redirect: 'manual' });
    assert.equal(login.status, 302, 'valid login must redirect');
    assert.match(login.location || '', /merchant\/dashboard/);
    assert.ok(login.cookie, 'login must set a session cookie');
    merchantCookie = login.cookie;
    const login2 = await req('POST', '/merchant/login', { body: form({ email: 'rebuild2@example.test', password: 'RebuildPass456' }), redirect: 'manual' });
    assert.ok(login2.cookie);
    merchant2Cookie = login2.cookie;
    // Simplified registration leaves UPI blank by design; complete it via
    // the profile page (the onboarding step) before creating an order.
    const profile = await req('POST', '/merchant/profile', { cookie: merchantCookie, body: form({ _csrf: csrfTokenFor(merchantCookie, config.sessionSecret), business_name: 'Rebuild Store With A Very Long Business Name That Must Wrap Nicely On Small Screens Without Clipping', contact_email: 'rebuild1@example.test', contact_phone: '', upi_id: 'rebuild1@okhdfc', payee_name: 'Rebuild One' }), redirect: 'manual' });
    assert.ok([200, 302].includes(profile.status), profile.text.slice(0, 500));
    // One sandbox order for merchant 1, to give the dashboard real data.
    const order = await req('POST', '/merchant/orders', { cookie: merchantCookie, body: form({ _csrf: csrfTokenFor(merchantCookie, config.sessionSecret), amount_rupees: '499.00', merchant_order_id: 'REBUILD-ORDER-001', mode: 'sandbox' }), redirect: 'manual' });
    assert.ok([200, 302].includes(order.status), order.text.slice(0, 500));
    const [orders] = await pool.query('SELECT gateway_reference FROM orders WHERE merchant_id = ? ORDER BY created_at DESC LIMIT 1', [merchantId]);
    assert.equal(orders.length, 1);
    orderRef = orders[0].gateway_reference;
  });

  test('merchant login: valid session persists; invalid shows a clear styled error', async () => {
    const dash = await req('GET', '/merchant/dashboard', { cookie: merchantCookie });
    assert.equal(dash.status, 200, dash.text.slice(0, 500));
    assert.match(dash.text, /Rebuild Store With A Very Long Business Name/);
    assert.match(dash.text, /Total orders/);
    const bad = await req('POST', '/merchant/login', { body: form({ email: 'rebuild1@example.test', password: 'WrongPassword123' }) });
    assert.equal(bad.status, 401);
    assert.match(bad.text, /Invalid email or password/);
    assert.match(bad.text, /auth-shell/, 'login errors must render in the styled auth layout, not raw text');
    assert.doesNotMatch(bad.text, /RebuildPass123|password_hash|scrypt/, 'no secret may leak into an error page');
  });

  test('merchant dashboard and panel pages all load with real data', async () => {
    for (const p of ['/merchant/dashboard', '/merchant/orders', `/merchant/orders/${orderRef}`, '/merchant/orders/new', '/merchant/api-keys', '/merchant/webhooks', '/merchant/subscription', '/merchant/subscription/change', '/merchant/profile', '/merchant/security', '/merchant/activity', '/merchant/support', '/merchant/docs']) {
      const r = await req('GET', p, { cookie: merchantCookie });
      assert.equal(r.status, 200, `${p} -> ${r.status}: ${r.text.slice(0, 300)}`);
    }
    const dash = await req('GET', '/merchant/dashboard', { cookie: merchantCookie });
    assert.match(dash.text, /REBUILD-ORDER-001|499\.00/, 'dashboard must show the real order data');
    assert.match(dash.text, /sidebar/, 'dashboard must use the app shell with sidebar navigation');
  });

  test('merchant navigation links all resolve; admin links are not open to merchants', async () => {
    const dash = await req('GET', '/merchant/dashboard', { cookie: merchantCookie });
    const links = navHrefs(dash.text, '/merchant/');
    assert.ok(links.length >= 8, `expected merchant nav links, got ${links.join(', ')}`);
    for (const link of links) {
      const r = await req('GET', link, { cookie: merchantCookie });
      assert.notEqual(r.status, 404, `merchant nav link ${link} must not 404`);
    }
    const adminDash = await req('GET', '/admin/dashboard', { cookie: merchantCookie, redirect: 'manual' });
    assert.equal(adminDash.status, 302, 'a merchant session must not open the admin dashboard');
    assert.match(adminDash.location || '', /admin\/login/);
  });

  test('unauthenticated users are redirected, not shown panels', async () => {
    for (const p of ['/merchant/dashboard', '/merchant/orders', '/admin/dashboard', '/admin/merchants', '/admin/settings']) {
      const r = await req('GET', p, { redirect: 'manual' });
      assert.equal(r.status, 302, p);
      assert.match(r.location || '', /login/);
    }
  });

  test('merchant isolation: one merchant cannot read another merchant order', async () => {
    const other = await req('GET', `/merchant/orders/${orderRef}`, { cookie: merchant2Cookie });
    assert.notEqual(other.status, 200, 'merchant 2 must not open merchant 1 order detail');
    assert.doesNotMatch(other.text, /REBUILD-ORDER-001/);
  });

  test('admin login, admin dashboard, and admin navigation all work', async () => {
    // Re-login fresh: the session from setup must still work, but a fresh
    // login proves the admin flow end to end at this point in the run.
    const fresh = await req('POST', '/admin/login', { body: form({ email: 'admin@example.test', password: 'TestAdmin1234' }), redirect: 'manual' });
    assert.ok(fresh.cookie, 'admin must be able to log in again');
    adminCookie = fresh.cookie;
    const dash = await req('GET', '/admin/dashboard', { cookie: adminCookie });
    assert.equal(dash.status, 200, dash.text.slice(0, 500));
    assert.match(dash.text, /Merchants/);
    assert.match(dash.text, /Subscriptions/);
    assert.match(dash.text, /Recent operational events/);
    const links = navHrefs(dash.text, '/admin/').filter((l) => l !== '/admin/logout');
    assert.ok(links.length >= 10, `expected admin nav links, got ${links.join(', ')}`);
    for (const link of links) {
      const r = await req('GET', link, { cookie: adminCookie });
      assert.equal(r.status, 200, `admin nav link ${link} -> ${r.status}`);
    }
    const detail = await req('GET', `/admin/merchants/${merchantId}`, { cookie: adminCookie });
    assert.equal(detail.status, 200);
    assert.match(detail.text, /Subscriptions/);
    assert.match(detail.text, /Webhook deliveries/);
    // An admin session must not open the merchant dashboard.
    const mDash = await req('GET', '/merchant/dashboard', { cookie: adminCookie, redirect: 'manual' });
    assert.equal(mDash.status, 302);
    assert.match(mDash.location || '', /merchant\/login/);
  });

  test('admin panel is linked from public and auth pages', async () => {
    const home = await req('GET', '/');
    assert.match(home.text, /href="\/admin\/login"/, 'footer must link the admin login');
    const login = await req('GET', '/merchant/login');
    assert.match(login.text, /href="\/admin\/login"/, 'auth pages must link the admin login');
  });

  test('rate limit: styled HTML page, and another account is not blocked', async () => {
    let last;
    for (let i = 0; i < 35; i += 1) {
      last = await req('POST', '/merchant/login', { body: form({ email: 'hammer@example.test', password: 'WrongPassword123' }), headers: { Accept: 'text/html' } });
    }
    assert.equal(last.status, 429, 'repeated failed logins must eventually rate-limit');
    assert.match(last.text, /Too many attempts/);
    assert.doesNotMatch(last.text, /^\s*\{/, 'a browser rate-limit page must not be raw JSON');
    assert.match(last.text, /merchant\/login/);
    // A different account from the same IP must still be able to log in.
    const ok = await req('POST', '/merchant/login', { body: form({ email: 'rebuild1@example.test', password: 'RebuildPass123' }), redirect: 'manual' });
    assert.equal(ok.status, 302, 'rate limiting one account must not block another account');
  });

  test('layout and assets: stylesheet serves, responsive CSS present, no broken asset paths', async () => {
    const home = await req('GET', '/');
    assert.equal(home.status, 200);
    assert.match(home.text, /\/public\/css\/style\.css/);
    const css = await req('GET', '/public/css/style.css');
    assert.equal(css.status, 200);
    assert.match(css.text, /@media\(max-width:720px\)/);
    assert.match(css.text, /@media\(max-width:1024px\)/);
    assert.match(css.text, /table-wrap/);
    assert.match(css.text, /min-width:0/);
    assert.match(css.text, /overflow-wrap:anywhere/);
    for (const m of home.text.matchAll(/(?:src|href)="(\/public\/[^"]+)"/g)) {
      const asset = await req('GET', m[1]);
      assert.equal(asset.status, 200, `asset ${m[1]} must serve`);
    }
    const health = await req('GET', '/health');
    assert.equal(health.status, 200);
    assert.match(health.text, /"status":"ok"/);
  });

  test('startup files: entry point and start script are intact', async () => {
    assert.ok(fs.existsSync(path.join(gatewayRoot, 'src', 'index.js')), 'gateway/src/index.js must exist');
    const rootPkg = JSON.parse(fs.readFileSync(path.join(gatewayRoot, '..', 'package.json'), 'utf8'));
    assert.match(rootPkg.scripts.start, /gateway/, 'root start script must launch the gateway');
    const gwPkg = JSON.parse(fs.readFileSync(path.join(gatewayRoot, 'package.json'), 'utf8'));
    assert.ok(gwPkg.engines.node.includes('20') || gwPkg.engines.node.includes('22'), 'gateway must declare its Node engine');
  });

  test('logout invalidates the session server-side', async () => {
    const out = await req('GET', '/merchant/logout', { cookie: merchantCookie, redirect: 'manual' });
    assert.ok([200, 302].includes(out.status));
    const dash = await req('GET', '/merchant/dashboard', { cookie: merchantCookie, redirect: 'manual' });
    assert.equal(dash.status, 302, 'a logged-out session must not open the dashboard');
    assert.match(dash.location || '', /merchant\/login/);
  });

  test('degraded mode: pre-004 database still serves merchant and admin pages', async () => {
    // Simulate a database created before the SaaS migration (001-003 only)
    // by dropping the 004 tables. Pages must degrade with guidance, not 500.
    await pool.query('SET FOREIGN_KEY_CHECKS=0');
    for (const table of ['support_messages', 'email_verifications', 'password_resets', 'merchant_subscriptions', 'subscription_plans']) {
      await pool.query(`DROP TABLE IF EXISTS \`${table}\``);
    }
    await pool.query('SET FOREIGN_KEY_CHECKS=1');
    // Re-login merchant 2 (its session still exists; use a fresh login).
    const login2 = await req('POST', '/merchant/login', { body: form({ email: 'rebuild2@example.test', password: 'RebuildPass456' }), redirect: 'manual' });
    assert.ok(login2.cookie);
    const dash = await req('GET', '/merchant/dashboard', { cookie: login2.cookie });
    assert.equal(dash.status, 200, `dashboard on pre-004 DB -> ${dash.status}`);
    const sub = await req('GET', '/merchant/subscription', { cookie: login2.cookie });
    assert.equal(sub.status, 200);
    assert.match(sub.text, /not installed yet/);
    const adminDash = await req('GET', '/admin/dashboard', { cookie: adminCookie });
    assert.equal(adminDash.status, 200);
    const adminSubs = await req('GET', '/admin/subscriptions', { cookie: adminCookie });
    assert.equal(adminSubs.status, 200);
    const adminUsage = await req('GET', '/admin/usage', { cookie: adminCookie });
    assert.equal(adminUsage.status, 200);
    const support = await req('GET', '/merchant/support', { cookie: login2.cookie });
    assert.equal(support.status, 200, 'support page must render even when its table is missing');
  });
});
