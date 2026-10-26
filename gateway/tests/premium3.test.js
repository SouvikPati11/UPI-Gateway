import test, { describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Premium SaaS redesign regressions: 5-step workflow, demo chart mock,
// real-data SVG trend charts (admin + merchant, incl. empty state),
// copy buttons, webhook signature explainer, 6-step docs guide.
// Disposable test database only, same gate as the other suites:
//   GATEWAY_TEST_MYSQL=1 DB_HOST=localhost DB_PORT=3306 \
//   DB_USER=youpi_test DB_PASSWORD='<redacted>' \
//   DB_NAME=youpi_gateway_test npm test
const enabled = process.env.GATEWAY_TEST_MYSQL === '1'
  && Boolean(process.env.DB_HOST && process.env.DB_USER && process.env.DB_PASSWORD && process.env.DB_NAME);

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const gatewayRoot = path.resolve(__dirname, '..');

describe('Premium SaaS redesign: charts, copy, docs, homepage', { skip: !enabled }, () => {
  let pool;
  let server;
  let base;
  let config;
  let adminCookie;
  let merchantCookie;
  let emptyMerchantCookie;

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

  async function makeMerchant(email, withOrder) {
    const created = await req('POST', '/merchant/register', { body: form({ business_name: `Shop ${email}`, contact_email: email, password: 'ShopPass123', password_confirm: 'ShopPass123' }) });
    assert.equal(created.status, 200, created.text.slice(0, 300));
    const { csrfTokenFor } = await import('../src/auth.js');
    const [m] = await pool.query('SELECT id FROM merchants WHERE contact_email = ?', [email]);
    const approve = await req('POST', `/admin/merchants/${m[0].id}/approve`, { cookie: adminCookie, body: form({ _csrf: csrfTokenFor(adminCookie, config.sessionSecret) }), redirect: 'manual' });
    assert.ok([200, 302].includes(approve.status));
    const login = await req('POST', '/merchant/login', { body: form({ email, password: 'ShopPass123' }), redirect: 'manual' });
    assert.ok(login.cookie);
    if (withOrder) {
      const profile = await req('POST', '/merchant/profile', { cookie: login.cookie, body: form({ _csrf: csrfTokenFor(login.cookie, config.sessionSecret), business_name: `Shop ${email}`, contact_email: email, contact_phone: '', upi_id: 'shop@okhdfc', payee_name: 'Shop' }), redirect: 'manual' });
      assert.ok([200, 302].includes(profile.status), profile.text.slice(0, 300));
      const order = await req('POST', '/merchant/orders', { cookie: login.cookie, body: form({ _csrf: csrfTokenFor(login.cookie, config.sessionSecret), amount_rupees: '499.00', merchant_order_id: 'P3-001', mode: 'sandbox' }), redirect: 'manual' });
      assert.ok([200, 302].includes(order.status), order.text.slice(0, 300));
    }
    return login.cookie;
  }

  test('setup: installer, admin, merchant with an order, merchant without orders', async () => {
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
    merchantCookie = await makeMerchant('p3@example.test', true);
    emptyMerchantCookie = await makeMerchant('p3empty@example.test', false);
  });

  test('homepage: five-step workflow, demo chart mock, SVG feature icons', async () => {
    const home = await req('GET', '/');
    assert.equal(home.status, 200);
    assert.match(home.text, /in five steps/);
    const steps = home.text.match(/class="step"/g) || [];
    assert.equal(steps.length, 5, `workflow must have exactly 5 steps, found ${steps.length}`);
    assert.match(home.text, /<h3>Verification<\/h3>/);
    assert.match(home.text, /never proves payment on its own/);
    assert.match(home.text, /mock-wide/);
    assert.match(home.text, /Demo illustration — sample bars only, not company performance/);
    assert.match(home.text, /<div class="feature-icon" aria-hidden="true"><svg/);
    assert.match(home.text, /style\.css\?v=5/);
  });

  test('design system CSS: violet/electric accents, drawer intact, chart + copy styles', async () => {
    const css = await req('GET', '/public/css/style.css?v=5');
    assert.equal(css.status, 200);
    assert.match(css.contentType || '', /text\/css/);
    assert.match(css.text, /--violet:#7c3aed/);
    assert.match(css.text, /#7c3aed 55%,#2563eb/);
    assert.match(css.text, /width:min\(88vw,320px\)/);
    assert.match(css.text, /\.copy-btn/);
    assert.match(css.text, /\.chart-legend/);
    assert.match(css.text, /\.mock-wide/);
  });

  test('admin dashboard: real-data trend chart + success/pending/failed counts', async () => {
    const ad = await req('GET', '/admin/dashboard', { cookie: adminCookie });
    assert.equal(ad.status, 200);
    assert.match(ad.text, /Orders per day — last 14 days/);
    assert.match(ad.text, /<svg viewBox="0 0 560 156"/);
    assert.match(ad.text, /Source: orders table, last 14 days/);
    assert.match(ad.text, /Total revenue/);
    assert.match(ad.text, /Total orders/);
    assert.match(ad.text, /stat-card/);
    assert.match(ad.text, /Prior 14 days/);
    assert.doesNotMatch(ad.text, /Demo illustration/);
  });

  test('merchant dashboard: chart with data, and honest empty state without orders', async () => {
    const md = await req('GET', '/merchant/dashboard', { cookie: merchantCookie });
    assert.equal(md.status, 200);
    assert.match(md.text, /Orders per day — last 14 days/);
    assert.match(md.text, /<svg viewBox="0 0 560 156"/);
    const empty = await req('GET', '/merchant/dashboard', { cookie: emptyMerchantCookie });
    assert.equal(empty.status, 200);
    assert.match(empty.text, /No orders in the last 14 days, so there is no trend to chart yet/);
    assert.doesNotMatch(empty.text, /<svg viewBox="0 0 560 156"/);
  });

  test('API keys: copy buttons and one-time secret copy, public vs secret explained', async () => {
    const page = await req('GET', '/merchant/api-keys', { cookie: merchantCookie });
    assert.equal(page.status, 200);
    assert.match(page.text, /Secret keys.*belong on your server only/s);
    assert.match(page.text, /Only the key prefix is stored in this table/);
    const { csrfTokenFor } = await import('../src/auth.js');
    const created = await req('POST', '/merchant/api-keys', { cookie: merchantCookie, body: form({ _csrf: csrfTokenFor(merchantCookie, config.sessionSecret), name: 'Website', key_type: 'secret' }), redirect: 'manual' });
    assert.ok(created.location && created.location.includes('new_key='), created.location || '');
    const shown = await req('GET', created.location, { cookie: merchantCookie });
    assert.equal(shown.status, 200);
    assert.match(shown.text, /shown only once/);
    assert.match(shown.text, /data-copy-text="sk_/);
    assert.match(shown.text, /Copy<\/button>/);
  });

  test('webhooks page: signature verification explainer with the real scheme', async () => {
    const w = await req('GET', '/merchant/webhooks', { cookie: merchantCookie });
    assert.equal(w.status, 200);
    assert.match(w.text, /How to verify a webhook signature/);
    assert.match(w.text, /X-Gateway-Signature: sha256=/);
    assert.match(w.text, /X-Gateway-Timestamp/);
    assert.match(w.text, /X-Gateway-Delivery-Id/);
    assert.match(w.text, /timingSafeEqual/);
    assert.match(w.text, /raw request body/);
  });

  test('merchant docs: 6-step guide, server-side status check, sandbox demo flow', async () => {
    const d = await req('GET', '/merchant/docs', { cookie: merchantCookie });
    assert.equal(d.status, 200);
    assert.match(d.text, /Integration in 6 steps/);
    assert.match(d.text, /Verify payment status server-side/);
    assert.match(d.text, /Verify webhook signatures/);
    assert.match(d.text, /GET \/api\/v1\/orders\/:gateway_reference|api\/v1\/orders\/YP/);
    assert.match(d.text, /verificationSource/);
    assert.match(d.text, /Demo flow \(sandbox\)/);
    assert.match(d.text, /never moves real money/);
    assert.match(d.text, /"mode":"sandbox"/);
    assert.match(d.text, /Never fulfil an order from a redirect/);
  });

  test('copy script is present on shells and drawer close behaviour survives', async () => {
    const md = await req('GET', '/merchant/dashboard', { cookie: merchantCookie });
    assert.match(md.text, /navigator\.clipboard/);
    assert.match(md.text, /Copied!/);
    assert.match(md.text, /data-close-menu/);
    assert.match(md.text, /Escape/);
  });
});
