import test, { describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// SaaS integration tests — run ONLY with a disposable test database,
// exactly like tests/integration.test.js. Otherwise skipped.
//   GATEWAY_TEST_MYSQL=1 DB_HOST=localhost DB_PORT=3306 \
//   DB_USER=youpi_test DB_PASSWORD='<redacted>' \
//   DB_NAME=youpi_gateway_test npm test
// The database is dropped and recreated here, so it must never be a
// production database.
const enabled = process.env.GATEWAY_TEST_MYSQL === '1'
  && Boolean(process.env.DB_HOST && process.env.DB_USER && process.env.DB_PASSWORD && process.env.DB_NAME);

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const gatewayRoot = path.resolve(__dirname, '..');

describe('SaaS: public pages, subscriptions, password reset, support, isolation', { skip: !enabled }, () => {
  let pool;
  let server;
  let base;
  let config;
  let adminCookie;
  let merchantCookie;
  let merchant2Cookie;
  let secretKey;
  let merchantId;
  let merchant2Id;

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
    delete process.env.SMTP_HOST;
    delete process.env.SMTP_USER;
    delete process.env.SMTP_PASS;
    delete process.env.SMTP_FROM;
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

  test('setup: installer, two merchants, admin approval, API key', async () => {
    const r = await req('POST', '/install', { body: form({
      db_host: process.env.DB_HOST, db_port: String(process.env.DB_PORT || 3306),
      db_name: process.env.DB_NAME, db_user: process.env.DB_USER, db_password: process.env.DB_PASSWORD,
      admin_name: 'Test Admin', admin_email: 'admin@example.test', admin_password: 'TestAdmin1234', admin_password_confirm: 'TestAdmin1234',
      confirm_empty_or_checked: 'yes',
    }) });
    assert.equal(r.status, 200, r.text.slice(0, 500));
    assert.match(r.text, /Installation complete/);
    await req('POST', '/merchant/register', { body: form({
      business_name: 'SaaS Test Store', slug: 'saas-test', contact_email: 'saas@example.test',
      contact_phone: '9876543210', upi_id: 'saas@okhdfc', payee_name: 'SaaS Test', password: 'MerchantPass123',
    }) });
    await req('POST', '/merchant/register', { body: form({
      business_name: 'Second Store', slug: 'second-store', contact_email: 'second@example.test',
      contact_phone: '9876543211', upi_id: 'second@okhdfc', payee_name: 'Second', password: 'SecondPass123',
    }) });
    const login = await req('POST', '/merchant/login', { body: form({ email: 'saas@example.test', password: 'MerchantPass123' }), redirect: 'manual' });
    assert.ok(login.cookie);
    merchantCookie = login.cookie;
    const login2 = await req('POST', '/merchant/login', { body: form({ email: 'second@example.test', password: 'SecondPass123' }), redirect: 'manual' });
    assert.ok(login2.cookie);
    merchant2Cookie = login2.cookie;
    const adminLogin = await req('POST', '/admin/login', { body: form({ email: 'admin@example.test', password: 'TestAdmin1234' }), redirect: 'manual' });
    assert.ok(adminLogin.cookie);
    adminCookie = adminLogin.cookie;
    const { csrfTokenFor } = await import('../src/auth.js');
    const [rows] = await pool.query('SELECT id FROM merchants WHERE slug = ?', ['saas-test']);
    merchantId = rows[0].id;
    const [rows2] = await pool.query('SELECT id FROM merchants WHERE slug = ?', ['second-store']);
    merchant2Id = rows2[0].id;
    for (const id of [merchantId, merchant2Id]) {
      const approve = await req('POST', `/admin/merchants/${id}/approve`, { cookie: adminCookie, body: form({ _csrf: csrfTokenFor(adminCookie, config.sessionSecret) }), redirect: 'manual' });
      assert.ok([200, 302].includes(approve.status));
    }
    const created = await req('POST', '/merchant/api-keys', { cookie: merchantCookie, body: form({ _csrf: csrfTokenFor(merchantCookie, config.sessionSecret), name: 'Website', key_type: 'secret' }), redirect: 'manual' });
    assert.equal(created.status, 302);
    secretKey = new URL(created.location, base).searchParams.get('new_key');
    assert.ok(secretKey && secretKey.startsWith('sk_'));
  });

  test('migration 004 seeds four default plans', async () => {
    const [rows] = await pool.query('SELECT slug, price_monthly_paise, transaction_limit, api_limit FROM subscription_plans ORDER BY price_monthly_paise ASC');
    assert.deepEqual(rows.map((r) => r.slug), ['free', 'basic', 'pro', 'business']);
    assert.equal(Number(rows[0].price_monthly_paise), 0);
    assert.equal(Number(rows[1].price_monthly_paise), 49900);
    assert.equal(Number(rows[2].price_monthly_paise), 149900);
    assert.equal(Number(rows[3].price_monthly_paise), 399900);
    assert.equal(rows[3].transaction_limit, null, 'Business plan must be unlimited');
  });

  test('public pages render with real content, no fake metrics', async () => {
    for (const p of ['/', '/features', '/pricing', '/docs', '/faq', '/support', '/contact', '/legal', '/terms', '/privacy', '/refund-policy']) {
      const r = await req('GET', p);
      assert.equal(r.status, 200, `${p} -> ${r.status}`);
    }
    const pricing = await req('GET', '/pricing');
    assert.match(pricing.text, /Free/);
    assert.match(pricing.text, /Basic/);
    assert.match(pricing.text, /Pro/);
    assert.match(pricing.text, /Business/);
    const home = await req('GET', '/');
    assert.match(home.text, /payment verification/i);
    assert.doesNotMatch(home.text, /10,000\+ merchants|trusted by millions/i);
  });

  test('subscription limit blocks the third API order, then admin verify flow for paid upgrade', async () => {
    const { csrfTokenFor } = await import('../src/auth.js');
    // Admin creates a free plan with a 2-order monthly limit.
    const created = await req('POST', '/admin/plans', { cookie: adminCookie, body: form({ _csrf: csrfTokenFor(adminCookie, config.sessionSecret), name: 'Tiny', slug: 'tiny', description: 'Test limit plan', price_monthly_paise: '0', price_annual_paise: '0', transaction_limit: '2', api_limit: '', features: 'Test' }), redirect: 'manual' });
    assert.ok([200, 302].includes(created.status), created.text.slice(0, 500));
    const [plans] = await pool.query('SELECT id FROM subscription_plans WHERE slug = ?', ['tiny']);
    assert.ok(plans[0]);
    const assigned = await req('POST', '/admin/subscriptions/assign', { cookie: adminCookie, body: form({ _csrf: csrfTokenFor(adminCookie, config.sessionSecret), merchant_id: merchantId, plan_id: plans[0].id, billing_cycle: 'monthly', billing_reference: '', billing_note: '' }), redirect: 'manual' });
    assert.ok([200, 302].includes(assigned.status), assigned.text.slice(0, 500));
    const [subs] = await pool.query("SELECT status FROM merchant_subscriptions WHERE merchant_id = ? AND plan_id = ?", [merchantId, plans[0].id]);
    assert.equal(subs[0].status, 'active');
    for (const mid of ['LIMIT-1', 'LIMIT-2']) {
      const ok = await req('POST', '/api/v1/orders', { headers: { Authorization: `Bearer ${secretKey}` }, body: JSON.stringify({ merchant_order_id: mid, amount_paise: 1000 }) });
      assert.equal(ok.status, 201, ok.text.slice(0, 500));
    }
    const blocked = await req('POST', '/api/v1/orders', { headers: { Authorization: `Bearer ${secretKey}` }, body: JSON.stringify({ merchant_order_id: 'LIMIT-3', amount_paise: 1000 }) });
    assert.equal(blocked.status, 403, blocked.text.slice(0, 500));
    assert.match(blocked.text, /limit/i);
    const [gone] = await pool.query('SELECT * FROM orders WHERE merchant_order_id = ?', ['LIMIT-3']);
    assert.equal(gone.length, 0, 'a limit-blocked order must not be created');

    // Paid upgrade stays pending until an admin verifies manual billing.
    const [basic] = await pool.query('SELECT id FROM subscription_plans WHERE slug = ?', ['basic']);
    const change = await req('POST', '/merchant/subscription/change', { cookie: merchantCookie, body: form({ _csrf: csrfTokenFor(merchantCookie, config.sessionSecret), plan_id: basic[0].id, billing_cycle: 'monthly' }) });
    assert.equal(change.status, 200, change.text.slice(0, 500));
    assert.match(change.text, /pending payment verification/i);
    const [pending] = await pool.query("SELECT id, status, payment_status FROM merchant_subscriptions WHERE merchant_id = ? AND plan_id = ? AND status = 'pending_payment'", [merchantId, basic[0].id]);
    assert.ok(pending[0]);
    const [current] = await pool.query("SELECT plan_id FROM merchant_subscriptions WHERE merchant_id = ? AND status = 'active'", [merchantId]);
    assert.equal(current[0].plan_id, plans[0].id, 'current plan must stay Tiny until verification');
    const verified = await req('POST', `/admin/subscriptions/${pending[0].id}/verify-payment`, { cookie: adminCookie, body: form({ _csrf: csrfTokenFor(adminCookie, config.sessionSecret), billing_reference: 'BANK-REF-123', billing_note: 'Manual billing confirmed' }), redirect: 'manual' });
    assert.ok([200, 302].includes(verified.status), verified.text.slice(0, 500));
    const [after] = await pool.query('SELECT status, payment_status, billing_reference FROM merchant_subscriptions WHERE id = ?', [pending[0].id]);
    assert.equal(after[0].status, 'active');
    assert.equal(after[0].payment_status, 'verified_manual');
    assert.equal(after[0].billing_reference, 'BANK-REF-123');
    const [old] = await pool.query("SELECT status FROM merchant_subscriptions WHERE merchant_id = ? AND plan_id = ?", [merchantId, plans[0].id]);
    assert.equal(old[0].status, 'cancelled', 'previous plan must be cancelled after verification');
  });

  test('password reset: generic response, single-use token, old sessions invalidated', async () => {
    const forgot = await req('POST', '/merchant/forgot-password', { body: form({ email: 'saas@example.test' }) });
    assert.equal(forgot.status, 200);
    assert.doesNotMatch(forgot.text, /sk_|token=[a-f0-9]{32,}/i, 'forgot-password response must never leak a token');
    const preResetCookie = merchantCookie;
    const { createPasswordReset } = await import('../src/account-security.js');
    const { token } = await createPasswordReset(pool, 'merchant', merchantId);
    const reset = await req('POST', '/merchant/reset-password', { body: form({ token, new_password: 'ResetPass1234', new_password_confirm: 'ResetPass1234' }) });
    assert.equal(reset.status, 200, reset.text.slice(0, 500));
    assert.match(reset.text, /Password reset/);
    const stale = await req('GET', '/merchant/dashboard', { cookie: preResetCookie, redirect: 'manual' });
    assert.equal(stale.status, 302, 'pre-reset session must be invalidated');
    assert.match(stale.location || '', /merchant\/login/);
    const reuse = await req('POST', '/merchant/reset-password', { body: form({ token, new_password: 'ResetPass1234', new_password_confirm: 'ResetPass1234' }) });
    assert.equal(reuse.status, 400, 'a reset token must be single-use');
    const oldLogin = await req('POST', '/merchant/login', { body: form({ email: 'saas@example.test', password: 'MerchantPass123' }), redirect: 'manual' });
    assert.equal(oldLogin.status, 401, 'old password must no longer work');
    const newLogin = await req('POST', '/merchant/login', { body: form({ email: 'saas@example.test', password: 'ResetPass1234' }), redirect: 'manual' });
    assert.ok(newLogin.cookie, 'new password must log in');
    merchantCookie = newLogin.cookie;
    // The pre-reset session must have been deleted by the reset.
    const dash = await req('GET', '/merchant/dashboard', { cookie: merchantCookie });
    assert.equal(dash.status, 200);
  });

  test('password change rejects wrong current password and keeps current session', async () => {
    const { csrfTokenFor } = await import('../src/auth.js');
    const wrong = await req('POST', '/merchant/security/password', { cookie: merchantCookie, body: form({ _csrf: csrfTokenFor(merchantCookie, config.sessionSecret), current_password: 'WrongPass9999', new_password: 'ChangedPass123', new_password_confirm: 'ChangedPass123' }) });
    assert.equal(wrong.status, 403, wrong.text.slice(0, 500));
    const ok = await req('POST', '/merchant/security/password', { cookie: merchantCookie, body: form({ _csrf: csrfTokenFor(merchantCookie, config.sessionSecret), current_password: 'ResetPass1234', new_password: 'ChangedPass123', new_password_confirm: 'ChangedPass123' }) });
    assert.ok([200, 302].includes(ok.status), ok.text.slice(0, 500));
    const still = await req('GET', '/merchant/dashboard', { cookie: merchantCookie });
    assert.equal(still.status, 200, 'current session must survive a password change');
    const login = await req('POST', '/merchant/login', { body: form({ email: 'saas@example.test', password: 'ChangedPass123' }), redirect: 'manual' });
    assert.ok(login.cookie);
    merchantCookie = login.cookie;
  });

  test('email verification via helper token, then security page shows verified', async () => {
    const { createEmailVerification } = await import('../src/account-security.js');
    const { token } = await createEmailVerification(pool, merchantId);
    const verified = await req('GET', `/merchant/verify-email?token=${token}`);
    assert.equal(verified.status, 200, verified.text.slice(0, 500));
    const security = await req('GET', '/merchant/security', { cookie: merchantCookie });
    assert.match(security.text, /Email verified: <strong>Yes<\/strong>/);
    const bad = await req('GET', '/merchant/verify-email?token=deadbeef');
    assert.equal(bad.status, 400);
  });

  test('support: contact saves a message, admin replies, merchant isolation holds', async () => {
    const saved = await req('POST', '/contact', { body: form({ name: 'SaaS User', email: 'saas@example.test', subject: 'Billing question', message: 'How do I upgrade my plan?' }) });
    assert.equal(saved.status, 200, saved.text.slice(0, 500));
    assert.doesNotMatch(saved.text, /email sent/i, 'contact must not claim an email was sent');
    const [msgs] = await pool.query('SELECT id, merchant_id, status FROM support_messages WHERE email = ?', ['saas@example.test']);
    assert.equal(msgs.length, 1);
    assert.equal(msgs[0].merchant_id, merchantId, 'contact message must link to the merchant by email');
    const { csrfTokenFor } = await import('../src/auth.js');
    const reply = await req('POST', `/admin/support/${msgs[0].id}/reply`, { cookie: adminCookie, body: form({ _csrf: csrfTokenFor(adminCookie, config.sessionSecret), admin_reply: 'Upgrade from your subscription page; an admin verifies payment.', status: 'answered' }), redirect: 'manual' });
    assert.ok([200, 302].includes(reply.status), reply.text.slice(0, 500));
    const [after] = await pool.query('SELECT status, admin_reply FROM support_messages WHERE id = ?', [msgs[0].id]);
    assert.equal(after[0].status, 'answered');
    assert.match(after[0].admin_reply, /Upgrade from your subscription page/);
    // Isolation: second merchant cannot see first merchant's subscription or activity.
    const otherSub = await req('GET', '/merchant/subscription', { cookie: merchant2Cookie });
    assert.equal(otherSub.status, 200);
    assert.doesNotMatch(otherSub.text, /Tiny|BANK-REF-123/);
    const otherActivity = await req('GET', '/merchant/activity', { cookie: merchant2Cookie });
    assert.equal(otherActivity.status, 200);
    assert.doesNotMatch(otherActivity.text, /subscription_payment_verified_manual/);
    const otherOrders = await req('GET', '/merchant/orders', { cookie: merchant2Cookie });
    assert.equal(otherOrders.status, 200);
    assert.doesNotMatch(otherOrders.text, /LIMIT-1/);
  });

  test('admin usage page and migrations endpoint work', async () => {
    const usage = await req('GET', '/admin/usage', { cookie: adminCookie });
    assert.equal(usage.status, 200, usage.text.slice(0, 500));
    assert.match(usage.text, /SaaS Test Store/);
    const { csrfTokenFor } = await import('../src/auth.js');
    const mig = await req('POST', '/admin/migrations', { cookie: adminCookie, body: form({ _csrf: csrfTokenFor(adminCookie, config.sessionSecret) }) });
    assert.equal(mig.status, 200, mig.text.slice(0, 500));
    assert.match(mig.text, /004_saas/);
  });
});
