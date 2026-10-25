import express from 'express';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import mysql from 'mysql2/promise';
import QRCode from 'qrcode';
import { randomUUID } from 'node:crypto';
import { getPool, closePool } from './db/pool.js';
import { migrate, listMigrationFiles } from './db/migrate.js';
import { hashPassword, verifyPassword, sha256Hex, generateApiKey, generateGatewayReference, generateWebhookSecret, encryptAtRest, decryptAtRest } from './crypto.js';
import { createSession, getSession, deleteSession, sessionCookieOptions, csrfTokenFor, verifyCsrf, createRateLimiter } from './auth.js';
import { escapeHtml, isEmail, isSlug, isUpiId, isUtr, parseAmountPaise, parseRupeesToPaise, validateReturnUrl, cleanString, pagination, formatPaise, formatDate, parseDbDateUtc } from './validate.js';
import { layout, alert, field, csrfField, statusBadge, ordersTable, paginationLinks } from './views.js';
import { buildUpiUri } from './upi.js';
import { isValidTransition, assertValidTransition } from './state-machine.js';
import { validateVerificationEvent } from './verification/adapter.js';
import { deliverWebhook, retryDueDeliveries, audit, addOrderEvent, isSafeWebhookUrl } from './webhooks.js';
import { getActivePlans, getPlanById, getPlanBySlug, getCurrentSubscription, getUsage, checkOrderAllowed, createSubscription, parsePlanFeatures, subscriptionPeriodDates, FALLBACK_PLANS } from './subscriptions.js';
import { createPasswordReset, findValidPasswordReset, markPasswordResetUsed, createEmailVerification, findValidEmailVerification, isEmailVerified } from './account-security.js';
import { mailerConfigured, sendMail } from './mailer.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const gatewayRoot = path.resolve(__dirname, '..');
const CHECKOUT_EXPIRY_MINUTES = 15;

function rowsOf(result) {
  return Array.isArray(result) ? result[0] : result;
}

async function getSetting(pool, key) {
  try {
    const [rows] = await pool.query('SELECT setting_value FROM app_settings WHERE setting_key = ?', [key]);
    if (!rows[0]) return null;
    const v = rows[0].setting_value;
    return typeof v === 'string' ? JSON.parse(v) : v;
  } catch {
    return null;
  }
}

async function setSetting(pool, key, value) {
  await pool.query(
    'INSERT INTO app_settings (setting_key, setting_value) VALUES (?, ?) ON DUPLICATE KEY UPDATE setting_value = VALUES(setting_value)',
    [key, JSON.stringify(value)],
  );
}

async function isInstalled(pool) {
  if (!pool) return false;
  const v = await getSetting(pool, 'installed');
  return v && (v.installed === true || v === true);
}

function utcNowSql() {
  return new Date().toISOString().slice(0, 19).replace('T', ' ');
}

async function expireOrderIfOverdue(pool, order, config) {
  if (!order.expires_at) return order;
  if (parseDbDateUtc(order.expires_at).getTime() > Date.now()) return order;
  if (!['pending', 'processing'].includes(order.status)) return order;
  await transitionOrder(pool, order, 'expired', { source: 'system', actorType: 'system', actorId: 'expiry', details: { reason: 'checkout_expired' }, config });
  const [rows] = await pool.query('SELECT * FROM orders WHERE id = ?', [order.id]);
  return rows[0];
}

async function transitionOrder(pool, order, to, { source, actorType, actorId, details, config, verificationUtr, verificationSource }) {
  assertValidTransition(order.status, to);
  const from = order.status;
  const updates = ['status = ?'];
  const params = [to];
  if (to === 'success') {
    updates.push('verified_at = UTC_TIMESTAMP()');
    if (verificationUtr) { updates.push('verification_utr = ?'); params.push(verificationUtr); }
    if (verificationSource) { updates.push('verification_source = ?'); params.push(verificationSource); }
  }
  params.push(order.id);
  await pool.query(`UPDATE orders SET ${updates.join(', ')} WHERE id = ?`, params);
  await addOrderEvent(pool, { orderId: order.id, eventType: `order_${to}`, statusFrom: from, statusTo: to, source, actorType, actorId, details: { ...details, verificationUtr: verificationUtr || undefined, verificationSource: verificationSource || undefined } });
  await audit(pool, { actorType: actorType || 'system', actorId: actorId || null, merchantId: order.merchant_id, entityType: 'order', entityId: order.gateway_reference, action: `order_${to}`, details: { from, to, source }, ip: null });
  if (['success', 'failed', 'expired', 'cancelled', 'refunded'].includes(to)) {
    const [merchants] = await pool.query('SELECT * FROM merchants WHERE id = ?', [order.merchant_id]);
    const [fresh] = await pool.query('SELECT * FROM orders WHERE id = ?', [order.id]);
    if (merchants[0] && fresh[0]) {
      const eventMap = { success: 'SUCCESS', failed: 'FAILED', expired: 'EXPIRED', cancelled: 'CANCELLED', refunded: 'REFUNDED' };
      await deliverWebhook(pool, { merchant: merchants[0], order: fresh[0], eventType: eventMap[to], config }).catch(() => {});
    }
  }
  return { from, to };
}

async function verifyOrderSuccess(pool, order, { source, actorType, actorId, details, config, verificationUtr, verificationSource }) {
  // The state machine has no pending -> success shortcut: verification
  // must pass through processing first, even for manual/provider/observer
  // decisions. This helper does both steps, with an event for each.
  let current = order;
  if (current.status === 'pending') {
    await transitionOrder(pool, current, 'processing', { source, actorType, actorId, details: { note: 'Moved to processing for verification' }, config });
    const [again] = await pool.query('SELECT * FROM orders WHERE id = ?', [order.id]);
    current = again[0];
  }
  await transitionOrder(pool, current, 'success', { source, actorType, actorId, details, config, verificationUtr, verificationSource });
}

async function queuePosition(pool, order) {
  if (order.status !== 'pending') return 1;
  const [countRows] = await pool.query(
    "SELECT COUNT(*) AS n FROM orders WHERE merchant_id = ? AND status IN ('pending', 'processing') AND seq < ?",
    [order.merchant_id, order.seq],
  );
  return Number(countRows[0]?.n || 0) + 1;
}

export function createApp({ config, pool: poolOverride = null, configErrors = [] }) {
  const app = express();
  app.set('trust proxy', 1);
  app.disable('x-powered-by');
  app.use('/public', express.static(path.join(gatewayRoot, 'public')));

  // Degraded / setup mode — the Hostinger fix.
  // Previously, a production config error threw in index.js BEFORE listen(),
  // so Hostinger reported "App did not call listen() within 3 seconds" and
  // returned 503, with no page to diagnose the problem. In degraded mode
  // the server still listens promptly, serves only diagnostics, the home
  // page (explaining the problem) and the installer, and blocks every
  // merchant, admin, API, checkout and webhook route with 503. No session
  // is created with a placeholder secret, no order is processed, and the
  // app is never reported as ready. Fix the environment variables in the
  // hosting panel and restart to leave degraded mode.
  if (Array.isArray(configErrors) && configErrors.length > 0) {
    const degradedBody = () => `
      <div class="alert error"><strong>Application configuration is invalid.</strong> The server started in setup mode so you can diagnose it, but merchant, admin, API and checkout features are disabled until the configuration is fixed and the app is restarted.</div>
      <ul>${configErrors.map((e) => `<li>${escapeHtml(e)}</li>`).join('')}</ul>
      <p>Fix the environment variables in the Hostinger Node.js App panel (see HOSTINGER_FIX.md for the exact list), then restart the application. Do not put real secrets in chat, in a committed file, or in a publicly accessible folder.</p>
      <p><a class="btn" href="/install">Open the installer</a> <a class="btn secondary" href="/install/diagnostics">Diagnostics (JSON)</a></p>
    `;
    app.get('/health', (req, res) => {
      res.json({ status: 'degraded', app: config.appName, stage: 'complete-gateway', config_valid: false, config_errors: configErrors, database: config.db.configured ? 'configured' : 'not_configured' });
    });
    app.get('/ready', (req, res) => {
      res.status(503).json({ status: 'not_ready', reason: 'config_invalid', config_errors: configErrors });
    });
    app.get('/', (req, res) => {
      res.send(layout({ title: 'Configuration required', body: degradedBody() }));
    });
    app.get('/install/diagnostics', async (req, res) => {
      const pool = poolOverride || (config.db.configured ? (() => { try { return getPool(config); } catch { return null; } })() : null);
      const checks = {
        node: process.version, nodeMinimum: '>= 20.0.0',
        nodeOk: Number(process.version.slice(1).split('.')[0]) >= 20,
        config_valid: false, config_errors: configErrors,
        databaseConfigured: Boolean(pool), databaseReachable: false,
      };
      if (pool) {
        try { await pool.query('SELECT 1 AS ok'); checks.databaseReachable = true; } catch (err) {
          checks.databaseError = String(err?.message || err);
        }
      }
      res.json(checks);
    });
    // Allow only /install and /public through to the full routes below
    // (so the installer, which uses form-supplied database values, can run).
    // Everything else is blocked here, before any merchant/admin/API route.
    app.use((req, res, next) => {
      if (req.path === '/install' || req.path.startsWith('/install/') || req.path.startsWith('/public/')) return next();
      if (req.accepts('html')) return res.status(503).send(layout({ title: 'Configuration required', body: degradedBody() }));
      return res.status(503).json({ error: 'Application configuration is invalid. Fix the environment variables and restart.', config_errors: configErrors });
    });
  }

  // Provider webhook needs the raw body for HMAC verification, so it is
  // registered before the JSON parser.
  app.post('/api/v1/provider/webhook', express.raw({ type: 'application/json', limit: '256kb' }), async (req, res) => {
    const pool = poolOverride || (config.db.configured ? getPool(config) : null);
    if (!pool) return res.status(503).json({ error: 'Database not configured' });
    const secret = process.env.PROVIDER_WEBHOOK_SECRET || config.providerWebhookSecret || '';
    if (!secret) return res.status(501).json({ error: 'provider_not_configured', message: 'No provider webhook is configured. This integration requires a real provider and credentials; it is not enabled by default.' });
    const crypto = await import('node:crypto');
    const signature = req.headers['x-provider-signature'] || '';
    const timestamp = Number(req.headers['x-provider-timestamp'] || 0);
    const deliveryId = req.headers['x-provider-delivery-id'] || '';
    if (!deliveryId || Math.abs(Date.now() - timestamp) > 5 * 60 * 1000) return res.status(401).json({ error: 'Invalid provider webhook timestamp or delivery id' });
    const expected = `sha256=${crypto.createHmac('sha256', secret).update(req.body).digest('hex')}`;
    if (signature.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) {
      return res.status(401).json({ error: 'Invalid provider signature' });
    }
    let payload;
    try { payload = JSON.parse(req.body.toString('utf8')); } catch { return res.status(400).json({ error: 'Malformed JSON' }); }
    const event = {
      source: 'provider',
      merchantId: payload.merchantId,
      orderId: payload.gatewayReference || payload.orderId,
      amountPaise: payload.amountPaise,
      utr: payload.utr,
      fingerprintHash: sha256Hex(`${deliveryId}:${payload.gatewayReference || ''}:${payload.amountPaise || ''}`),
    };
    const errors = validateVerificationEvent(event);
    if (errors.length) return res.status(400).json({ error: errors.join(' ') });
    const [existing] = await pool.query('SELECT * FROM verification_events WHERE fingerprint_hash = ?', [event.fingerprintHash]);
    if (existing[0]) return res.json({ received: true, duplicate: true });
    const [orders] = await pool.query('SELECT * FROM orders WHERE gateway_reference = ? AND merchant_id = ?', [event.orderId, event.merchantId]);
    const order = orders[0];
    await pool.query(
      'INSERT INTO verification_events (id, merchant_id, order_id, source, amount_paise, external_reference, fingerprint_hash, raw_payload, attribution_status, attributed_order_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [randomUUID(), event.merchantId, order?.id || null, 'provider', event.amountPaise, event.utr || null, event.fingerprintHash, JSON.stringify(payload), order ? 'attributed' : 'unattributed', order?.id || null],
    );
    if (order && ['pending', 'processing'].includes(order.status) && Number(order.amount_paise) === Number(event.amountPaise) && payload.event === 'SUCCESS') {
      await verifyOrderSuccess(pool, order, { source: 'provider', actorType: 'provider', actorId: 'provider_webhook', details: { deliveryId }, config, verificationUtr: event.utr, verificationSource: 'provider' });
      return res.json({ received: true, status: 'success' });
    }
    return res.json({ received: true, status: 'held_for_review' });
  });

  app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    res.setHeader('X-Frame-Options', 'SAMEORIGIN');
    next();
  });
  app.use(express.json({ limit: '256kb' }));
  app.use(express.urlencoded({ extended: false, limit: '256kb' }));

  const loginLimiter = createRateLimiter({ windowMs: 15 * 60 * 1000, max: 30 });
  const apiLimiter = createRateLimiter({ windowMs: 60 * 1000, max: 120 });

  function poolOrNull(req, res) {
    const pool = poolOverride || (config.db.configured ? getPool(config) : null);
    if (!pool) {
      if (req.accepts('html')) return res.redirect('/install');
      return res.status(503).json({ error: 'Application not installed yet. Visit /install.' });
    }
    return pool;
  }

  async function merchantFromCookie(req) {
    const pool = poolOverride || (config.db.configured ? getPool(config) : null);
    if (!pool) return null;
    const token = req.headers.cookie?.split(';').map((c) => c.trim()).find((c) => c.startsWith('gw_session='))?.slice('gw_session='.length);
    if (!token) return null;
    const session = await getSession(pool, decodeURIComponent(token));
    if (!session || session.actor_type !== 'merchant') return null;
    const [rows] = await pool.query('SELECT * FROM merchants WHERE id = ?', [session.actor_id]);
    if (!rows[0]) return null;
    return { merchant: rows[0], session, token };
  }

  async function adminFromCookie(req) {
    const pool = poolOverride || (config.db.configured ? getPool(config) : null);
    if (!pool) return null;
    const token = req.headers.cookie?.split(';').map((c) => c.trim()).find((c) => c.startsWith('gw_session='))?.slice('gw_session='.length);
    if (!token) return null;
    const session = await getSession(pool, decodeURIComponent(token));
    if (!session || session.actor_type !== 'admin') return null;
    const [rows] = await pool.query('SELECT * FROM admins WHERE id = ?', [session.actor_id]);
    if (!rows[0] || rows[0].status !== 'active') return null;
    return { admin: rows[0], session, token };
  }

  function requireCsrf(req, res, next) {
    const token = req.headers.cookie?.split(';').map((c) => c.trim()).find((c) => c.startsWith('gw_session='))?.slice('gw_session='.length);
    const plain = token ? decodeURIComponent(token) : '';
    if (!verifyCsrf(req.body?._csrf, plain, config.sessionSecret)) {
      return res.status(403).send('CSRF validation failed. Please go back and try again.');
    }
    return next();
  }

  function merchantNav() {
    return `<a href="/merchant/dashboard">Dashboard</a> <a href="/merchant/orders">Orders</a> <a href="/merchant/orders/new">New order</a> <a href="/merchant/api-keys">API keys</a> <a href="/merchant/webhooks">Webhooks</a> <a href="/merchant/subscription">Subscription</a> <a href="/merchant/profile">Profile</a> <a href="/merchant/security">Security</a> <a href="/merchant/activity">Activity</a> <a href="/merchant/docs">Docs</a>`;
  }
  function adminNav() {
    return `<a href="/admin/dashboard">Dashboard</a> <a href="/admin/merchants">Merchants</a> <a href="/admin/orders">Orders</a> <a href="/admin/verify">Verification queue</a> <a href="/admin/plans">Plans</a> <a href="/admin/subscriptions">Subscriptions</a> <a href="/admin/usage">Usage</a> <a href="/admin/support">Support</a> <a href="/admin/webhooks">Webhooks</a> <a href="/admin/audit">Audit logs</a> <a href="/admin/settings">Settings</a>`;
  }
  function publicNav() {
    return `<a href="/">Home</a> <a href="/features">Features</a> <a href="/pricing">Pricing</a> <a href="/docs">Docs</a> <a href="/faq">FAQ</a> <a href="/support">Support</a> <a href="/contact">Contact</a>`;
  }
  function planPriceText(plan, cycle = 'monthly') {
    const paise = cycle === 'annual' ? Number(plan.price_annual_paise || 0) : Number(plan.price_monthly_paise || 0);
    return paise === 0 ? 'Free' : `${formatPaise(paise)} / ${cycle === 'annual' ? 'year' : 'month'}`;
  }
  function planCard(plan, cycle = 'monthly') {
    const features = parsePlanFeatures(plan);
    return `<div class="card"><h3>${escapeHtml(plan.name)}</h3><p class="big">${escapeHtml(planPriceText(plan, cycle))}</p><p>${escapeHtml(plan.description || '')}</p><p class="muted">Transactions / month: ${plan.transaction_limit === null || plan.transaction_limit === undefined ? 'Unlimited' : escapeHtml(String(plan.transaction_limit))} · API calls / month: ${plan.api_limit === null || plan.api_limit === undefined ? 'Unlimited' : escapeHtml(String(plan.api_limit))}</p>${features.length ? `<ul>${features.map((f) => `<li>${escapeHtml(f)}</li>`).join('')}</ul>` : ''}<p><a class="btn" href="/merchant/register">Start with ${escapeHtml(plan.name)}</a></p></div>`;
  }

  // ---------- Public ----------
  app.get('/health', (req, res) => {
    res.json({ status: 'ok', app: config.appName, stage: 'complete-gateway', verificationMode: config.verificationMode, database: config.db.configured ? 'configured' : 'not_configured' });
  });

  app.get('/ready', async (req, res) => {
    const pool = poolOverride || (config.db.configured ? getPool(config) : null);
    if (!pool) return res.status(503).json({ status: 'not_ready', reason: 'database_not_configured' });
    try {
      await pool.query('SELECT 1 AS ok');
      const installed = await isInstalled(pool);
      return res.json({ status: 'ready', installed });
    } catch {
      return res.status(503).json({ status: 'not_ready', reason: 'database_unavailable' });
    }
  });

  app.get('/', async (req, res) => {
    const pool = poolOverride || (config.db.configured ? getPool(config) : null);
    let installed = false;
    if (pool) installed = await isInstalled(pool);
    let plans = [];
    if (pool) {
      try { plans = await getActivePlans(pool); } catch { plans = []; }
    }
    if (!plans.length) plans = FALLBACK_PLANS;
    const body = `
      <div class="hero"><h2>Accept UPI payments for your business, without a complex setup.</h2><p class="lead">YOUPI PG is a multi-merchant UPI payment gateway: create payment links, share a QR checkout, track every order, and reconcile payments against your bank record. One Node.js app, one MySQL database, no Docker, Redis or PostgreSQL required.</p><p><a class="btn" href="/merchant/register">Register as a merchant</a> <a class="btn secondary" href="/merchant/login">Merchant login</a> <a class="btn secondary" href="/pricing">See pricing</a></p></div>
      ${installed ? '' : '<div class="alert info">This application is not installed yet. <a href="/install">Open the installation wizard</a> to connect MySQL, run migrations and create the first administrator.</div>'}
      <h2>What you get</h2>
      <div class="grid">
        <div class="card"><h3>UPI checkout</h3><p>Dynamic QR codes and UPI app deep links with the exact amount and gateway reference for every order. Checkout expires after 15 minutes.</p></div>
        <div class="card"><h3>Merchant dashboard</h3><p>Orders, payment links, API keys, webhooks, subscriptions and activity — all scoped to your own account, never to another merchant's data.</p></div>
        <div class="card"><h3>Safe verification</h3><p>A QR scan, a return from a UPI app, a screenshot or an “I have paid” click never marks an order successful. Orders succeed only after manual reconciliation or a configured, tested provider/observer.</p></div>
        <div class="card"><h3>API and webhooks</h3><p>Secret-key API, signed webhooks with retries, an SDK for checkout links, and sandbox mode that is clearly separated from real payments.</p></div>
      </div>
      <h2>Pricing</h2>
      <p class="muted">Plans below are the currently active plans in this installation. An administrator can change them in Admin &gt; Plans. Subscription billing is separate from the payments your customers make to you.</p>
      <div class="grid">${plans.map((p) => planCard(p)).join('')}</div>
      <p><a class="btn secondary" href="/pricing">Full pricing</a> <a class="btn secondary" href="/features">All features</a> <a class="btn secondary" href="/docs">Developer docs</a> <a class="btn secondary" href="/faq">FAQ</a></p>
      <h2>How payment verification works here</h2>
      <p>Scanning a QR code, opening a UPI app, returning to the site, uploading a screenshot, or clicking “I have paid” <strong>never</strong> marks an order successful. An order stays pending until it is verified by manual reconciliation, a configured provider, or an optional external observer — and the verification source is shown on every order. Sandbox orders are clearly labelled TEST and use synthetic references, never real bank confirmations.</p>
      <p><a href="/merchant/register">Register as a merchant</a> · <a href="/merchant/login">Merchant login</a> · <a href="/admin/login">Admin login</a> · <a href="/privacy">Privacy</a> · <a href="/refund-policy">Refund policy</a> · <a href="/terms">Terms</a></p>
    `;
    res.send(layout({ title: 'YOUPI PG — Multi-Merchant UPI Gateway', body, nav: publicNav() }));
  });

  // ---------- Public pages (real content, no fake metrics) ----------
  app.get('/features', async (req, res) => {
    const body = `
      <p class="lead">Everything a small or growing business needs to accept UPI payments, in one installation.</p>
      <div class="grid">
        <div class="card"><h3>Payment links and QR checkout</h3><p>Create an order from the dashboard or the API, share its checkout link, and let customers pay by scanning a QR code or opening their UPI app. Amount, currency (INR only) and gateway reference are fixed per order.</p></div>
        <div class="card"><h3>Transaction history and search</h3><p>Search by gateway reference, merchant order ID or UTR, filter by status, and open any order to see its full event history and webhook deliveries.</p></div>
        <div class="card"><h3>Manual reconciliation</h3><p>An admin compares each pending order against the merchant's official bank record before marking it successful, with duplicate-UTR protection and an audit trail.</p></div>
        <div class="card"><h3>API, SDK and webhooks</h3><p>Secret-key REST API, a checkout SDK that never needs a secret in the browser, and HMAC-signed webhooks with delivery history and retries.</p></div>
        <div class="card"><h3>Subscriptions</h3><p>Configurable plans with transaction and API limits, usage tracking, upgrade/downgrade requests, and admin-verified manual billing for paid plans.</p></div>
        <div class="card"><h3>Security</h3><p>Hashed passwords, hashed API secrets, encrypted webhook secrets, CSRF protection on account forms, rate limiting, merchant isolation on every query, and audit logs for sensitive actions.</p></div>
      </div>
      <p><a class="btn" href="/merchant/register">Register as a merchant</a> <a class="btn secondary" href="/pricing">See pricing</a></p>
    `;
    res.send(layout({ title: 'Features', body, nav: publicNav() }));
  });

  app.get('/pricing', async (req, res) => {
    const pool = poolOrNull(req, res); if (!pool || res.headersSent) return;
    let plans = [];
    try { plans = await getActivePlans(pool); } catch { plans = []; }
    if (!plans.length) plans = FALLBACK_PLANS;
    const cycle = req.query.cycle === 'annual' ? 'annual' : 'monthly';
    const body = `
      <p class="lead">Choose a plan. Prices are in INR, per merchant account. An administrator can change plan names, prices, limits and features in Admin &gt; Plans.</p>
      <p><a class="btn secondary" href="/pricing?cycle=monthly">Monthly</a> <a class="btn secondary" href="/pricing?cycle=annual">Annual</a></p>
      <div class="grid">${plans.map((p) => planCard(p, cycle)).join('')}</div>
      <h2>How subscription billing works</h2>
      <p>Subscription billing is separate from the payments your customers make to you. A subscription record alone is not proof that the subscription fee was paid. For a paid plan, a merchant requests an upgrade and an administrator verifies the subscription payment through manual billing before the plan becomes active. Free plans need no payment. If no payment provider is configured for subscriptions, only manual billing is available — that limitation is stated here deliberately, not hidden.</p>
      <p>Expired subscriptions get a 7-day grace period (where a grace date is set). After grace ends, new order creation is blocked until the subscription is renewed or changed. Existing order history and status checks remain available.</p>
    `;
    res.send(layout({ title: 'Pricing', body, nav: publicNav() }));
  });

  app.get('/docs', async (req, res) => {
    const body = `
      <p class="lead">Developer documentation — the same endpoints the dashboard uses, with real examples.</p>
      <h2>Authentication</h2>
      <p>Create a secret API key in the merchant dashboard under API keys. Send it as <code>Authorization: Bearer sk_...</code> or <code>X-Api-Key: sk_...</code>. Secret keys work only for approved merchants, only for their own account, and are shown exactly once at creation. Never put a secret key in browser JavaScript or HTML.</p>
      <h2>Create an order</h2>
      <pre>POST /api/v1/orders
Authorization: Bearer sk_YOUR_SECRET_KEY
Content-Type: application/json

{
  "merchant_order_id": "ORDER-1001",
  "amount_paise": 49900,
  "currency": "INR",
  "mode": "live",
  "return_url": "https://yourstore.example/order-done",
  "idempotency_key": "optional-unique-key"
}</pre>
      <p>Success is <code>201</code> with <code>order.checkout_url</code>, <code>gateway_reference</code>, <code>amount_paise</code> and <code>status: "pending"</code>. A duplicate <code>merchant_order_id</code> returns <code>409</code>; a matching <code>idempotency_key</code> returns the existing order. A non-INR currency returns <code>400</code> and no order is created. A non-http(s) <code>return_url</code> returns <code>400</code>.</p>
      <h2>Get an order</h2>
      <pre>GET /api/v1/orders/:gateway_reference
Authorization: Bearer sk_YOUR_SECRET_KEY</pre>
      <p>Returns the order only if it belongs to the authenticated merchant, otherwise <code>404</code>. Public status polling at <code>GET /api/public/orders/:gateway_reference/status</code> is used by the checkout page to refresh its status display.</p>
      <h2>Checkout SDK</h2>
      <p>Your server creates the order, then passes its <code>checkout_url</code> to the SDK: <code>YoupiCheckout.open(checkoutUrl)</code>, or add <code>data-youpi-checkout-url="..."</code> to a button. The SDK file is at <code>/public/sdk.js</code>. Full details, webhook signing and retry rules are in <code>docs/API.md</code> in the repository.</p>
      <h2>Webhooks</h2>
      <p>Set an https webhook URL in the merchant dashboard. Every terminal order event (SUCCESS, FAILED, EXPIRED, CANCELLED, REFUNDED) is delivered as JSON with <code>X-Gateway-Signature: sha256=&lt;hmac&gt;</code>, <code>X-Gateway-Delivery-Id</code> and <code>X-Gateway-Timestamp</code>. Verify the HMAC over the raw body with your webhook secret. Deliveries are retried with bounded backoff and can be retried manually from the dashboard. A webhook delivery is not proof that a payment succeeded — it only reports the gateway's recorded status.</p>
      <h2>Sandbox</h2>
      <p>Create an order with <code>mode: "sandbox"</code>, or use the dashboard's sandbox mode. Sandbox checkouts are labelled TEST and their simulator creates only a synthetic success. Sandbox orders are never marked as real payments in the manual verification queue.</p>
    `;
    res.send(layout({ title: 'Developer docs', body, nav: publicNav() }));
  });

  app.get('/faq', async (req, res) => {
    const body = `
      <h2>Is a QR scan proof of payment?</h2><p>No. A scan, a return from a UPI app, a screenshot, or an “I have paid” click only moves an order to processing. It becomes successful only after manual reconciliation against a bank record, or a configured and tested provider/observer confirmation.</p>
      <h2>Do you automatically verify payments with a bank?</h2><p>Not by default. No real bank/provider integration is included in this codebase. If you need automatic verification, you must configure a real provider, its credentials and its webhook secret, and test it. Until then, manual verification is the safe, supported workflow.</p>
      <h2>What is sandbox mode?</h2><p>A test mode for checkout, clearly labelled TEST. It never produces a real bank confirmation and its orders are never treated as real payments.</p>
      <h2>What does a refund mean here?</h2><p>A recorded refund in the gateway, with a REFUNDED webhook. It does not automatically move money back at the bank. Record the actual bank refund separately, then record it here.</p>
      <h2>How does subscription billing work?</h2><p>Separately from customer payments. Paid plan upgrades are requested by the merchant and verified by an admin through manual billing before they become active. Free plans need no payment.</p>
      <h2>Can one merchant see another merchant's data?</h2><p>No. Every merchant query and API check is scoped to that merchant's own account, and API keys, webhooks, subscriptions and orders are never shared across merchants.</p>
      <p><a href="/contact">Still stuck? Contact support</a></p>
    `;
    res.send(layout({ title: 'FAQ', body, nav: publicNav() }));
  });

  app.get('/contact', async (req, res) => {
    const body = `<p class="lead">Send a support message. It is stored in the admin support queue; it is not sent as an email unless an email service is configured for this installation.</p><form method="post" action="/contact">${field('Your name', 'name', 'text', '', 'required')}${field('Email', 'email', 'email', '', 'required')}${field('Subject', 'subject', 'text', '', 'required')}<label>Message<textarea name="message" rows="6" required style="width:100%;max-width:480px;padding:.5rem;border:1px solid #cbd5e1;border-radius:8px"></textarea></label><p><button class="btn" type="submit">Send message</button></p></form>`;
    res.send(layout({ title: 'Contact', body, nav: publicNav() }));
  });

  app.post('/contact', apiLimiter, async (req, res) => {
    const pool = poolOrNull(req, res); if (!pool || res.headersSent) return;
    const name = cleanString(req.body.name || '', 255);
    const email = cleanString(req.body.email || '', 255);
    const subject = cleanString(req.body.subject || '', 255);
    const message = cleanString(req.body.message || '', 5000);
    if (!name || !isEmail(email) || !subject || !message) {
      return res.status(400).send(layout({ title: 'Contact', body: `<div class="alert error">Please fill in your name, a valid email, a subject and a message.</div><p><a href="/contact">Back</a></p>`, nav: publicNav() }));
    }
    let merchantId = null;
    try {
      const [rows] = await pool.query('SELECT id FROM merchants WHERE contact_email = ?', [email]);
      if (rows[0]) merchantId = rows[0].id;
    } catch { /* support table may not exist yet; fall through to the error below */ }
    try {
      await pool.query('INSERT INTO support_messages (id, merchant_id, name, email, subject, message) VALUES (?, ?, ?, ?, ?, ?)', [randomUUID(), merchantId, name, email, subject, message]);
    } catch {
      return res.status(503).send(layout({ title: 'Contact', body: `<div class="alert error">Support messages are not available yet on this installation. Please run pending migrations from Admin &gt; Settings, then try again.</div>`, nav: publicNav() }));
    }
    res.send(layout({ title: 'Contact', body: `<div class="alert success">Thank you. Your message has been saved to the support queue. An administrator will review it from Admin &gt; Support.</div><p><a class="btn secondary" href="/">Back to home</a></p>`, nav: publicNav() }));
  });

  app.get('/support', async (req, res) => {
    const body = `
      <p class="lead">Help for merchants and developers.</p>
      <div class="grid">
        <div class="card"><h3>Developer docs</h3><p>API authentication, order creation, webhooks and sandbox testing.</p><p><a class="btn secondary" href="/docs">Read the docs</a></p></div>
        <div class="card"><h3>FAQ</h3><p>Verification, sandbox, refunds, subscriptions and merchant isolation.</p><p><a class="btn secondary" href="/faq">Read the FAQ</a></p></div>
        <div class="card"><h3>Contact support</h3><p>Send a message that an administrator reviews in Admin &gt; Support.</p><p><a class="btn secondary" href="/contact">Contact support</a></p></div>
      </div>
      <p class="muted">No live status page is shown here, because no external status service is configured for this installation. Do not treat a rendered page as proof that a payment or a subscription fee was verified.</p>
    `;
    res.send(layout({ title: 'Support', body, nav: publicNav() }));
  });

  app.get('/legal', async (req, res) => {
    res.send(layout({ title: 'Legal', body: `<p class="lead">Legal information for this YOUPI PG installation.</p><p><a href="/terms">Terms of service</a></p><p><a href="/privacy">Privacy policy</a></p><p><a href="/refund-policy">Refund policy</a></p><p class="muted">These pages describe how this specific gateway works. They are not legal advice, and the operator of this installation should have them reviewed for their jurisdiction before offering the service publicly.</p>`, nav: publicNav() }));
  });

  app.get('/terms', async (req, res) => {
    const body = `<p class="lead">Terms of service for merchants using this gateway.</p><p>1. The gateway records payment orders, checkout links and verification decisions. It does not, by itself, move money at a bank. A UPI payment is made by the customer in their own UPI app to the merchant's UPI ID.</p><p>2. Merchants must provide accurate business details and a UPI ID they control. The administrator may approve, reject, suspend or reactivate a merchant account.</p><p>3. Orders become successful only after manual reconciliation against a bank record, or a configured and tested provider/observer confirmation. QR scans, redirects, screenshots and “I have paid” clicks are not proof of payment.</p><p>4. Subscription plans, prices and limits are set by the administrator and may change; existing subscriptions keep the price recorded at subscription time until renewal or change.</p><p>5. Merchants must not use the gateway for unlawful activity, must not collect customer UPI PINs or banking passwords through it, and must keep their API secrets on their own servers only.</p>`;
    res.send(layout({ title: 'Terms of service', body, nav: publicNav() }));
  });

  app.get('/privacy', async (req, res) => {
    const body = `<p class="lead">Privacy policy for this gateway.</p><p>Data collected: merchant business and contact details, UPI ID and payee name, order and customer details supplied by the merchant, webhook delivery logs, and audit logs (actor, action, IP address and time) for sensitive actions.</p><p>Data not collected or stored: customer UPI PINs, banking passwords, full API secrets (only a hash and prefix are stored), and webhook secrets in plain text (they are encrypted at rest and shown only once).</p><p>Data use: operating the gateway, showing each merchant only their own data, delivering signed webhooks to the merchant's configured URL, and auditing sensitive actions. Data is not sold. Session cookies are HttpOnly and used only for login sessions.</p><p>Retention and deletion: order, event, webhook and audit records are kept for reconciliation. A merchant may ask an administrator to close an account; historical order and audit records are retained for reconciliation unless the law requires otherwise.</p>`;
    res.send(layout({ title: 'Privacy policy', body, nav: publicNav() }));
  });

  app.get('/refund-policy', async (req, res) => {
    const body = `<p class="lead">Refund policy for this gateway.</p><p>A refund recorded in this gateway means: an administrator has recorded that a refund was made for a successful order, and a REFUNDED webhook (if configured) is sent to the merchant. It does not, by itself, move money back at the bank.</p><p>To refund a customer, the merchant must first make the actual refund through their bank / UPI arrangement, then ask an administrator to record it (or record it themselves if they are an administrator) on the order's admin detail page, with a reason.</p><p>Only successful orders can be recorded as refunded. Pending, failed, expired or cancelled orders cannot be refunded through the gateway, because no successful payment was recorded for them.</p><p>Subscription fees are billed separately from customer payments. A subscription change or cancellation does not automatically refund customer payments, and does not automatically refund a subscription fee already verified by manual billing; contact support about a subscription billing question.</p>`;
    res.send(layout({ title: 'Refund policy', body, nav: publicNav() }));
  });

  // ---------- Diagnostics (no secrets in output) ----------
  app.get('/install/diagnostics', async (req, res) => {
    const pool = poolOverride || (config.db.configured ? getPool(config) : null);
    const checks = {
      node: process.version,
      nodeMinimum: '>= 20.0.0',
      nodeOk: Number(process.version.slice(1).split('.')[0]) >= 20,
      databaseConfigured: Boolean(pool),
      databaseReachable: false,
      migrations: [],
      installed: false,
    };
    if (pool) {
      try {
        await pool.query('SELECT 1 AS ok');
        checks.databaseReachable = true;
        const [tables] = await pool.query('SHOW TABLES');
        checks.tables = tables.map((r) => Object.values(r)[0]);
        const installed = await isInstalled(pool);
        checks.installed = installed;
        try {
          const [migs] = await pool.query('SELECT version FROM schema_migrations ORDER BY version ASC');
          checks.migrations = migs.map((r) => r.version);
        } catch { checks.migrations = []; }
      } catch (err) {
        checks.databaseError = String(err?.message || err).replace(/password[^,}]*/gi, '[redacted]');
      }
    }
    res.json(checks);
  });

  // ---------- Installer ----------
  app.get('/install', async (req, res) => {
    const pool = poolOverride || (config.db.configured ? getPool(config) : null);
    if (pool) {
      try {
        if (await isInstalled(pool)) {
          return res.send(layout({ title: 'Installer locked', body: '<div class="alert info">The installer is locked because this application is already installed. Log in as an administrator to manage settings. If you need to reinstall, restore an empty database and remove the installed flag — never run the installer against a live database without a backup.</div><p><a class="btn" href="/admin/login">Admin login</a></p>' }));
        }
      } catch { /* tables may not exist yet: show the wizard */ }
    }
    const body = `
      <p>Connect a MySQL / MariaDB database, run the versioned migrations, and create the first administrator. Migrations only create tables if they do not exist — they never drop or erase existing data.</p>
      <p class="muted">On cPanel, create the database and user in MySQL Databases first, then enter those details here. For production use, also set the same variables in the Node.js App panel so they survive a redeploy. This form never stores your database password in Git or in any committed file.</p>
      <form method="post" action="/install">
        <h3>1. Database (disposable test database for testing; production database only when you are ready)</h3>
        ${field('Database host', 'db_host', 'text', config.db.host || 'localhost', 'required')}
        ${field('Database port', 'db_port', 'text', String(config.db.port || 3306), 'required')}
        ${field('Database name', 'db_name', 'text', config.db.database || '', 'required')}
        ${field('Database user', 'db_user', 'text', config.db.user || '', 'required')}
        ${field('Database password', 'db_password', 'password', '', 'required autocomplete="new-password"')}
        <h3>2. First administrator (never a hardcoded password)</h3>
        ${field('Admin name', 'admin_name', 'text', '', 'required')}
        ${field('Admin email', 'admin_email', 'email', '', 'required')}
        ${field('Admin password (at least 10 characters)', 'admin_password', 'password', '', 'required autocomplete="new-password"')}
        ${field('Confirm admin password', 'admin_password_confirm', 'password', '', 'required autocomplete="new-password"')}
        <h3>3. Confirmation</h3>
        <label><input type="checkbox" name="confirm_empty_or_checked" value="yes"> I have checked the database above. If it already contains tables or rows, I understand the installer will only add missing tables and will not erase existing data, and I have a backup.</label>
        <p><button class="btn" type="submit">Test connection, run migrations and install</button></p>
      </form>
      <p><a href="/install/diagnostics">Run diagnostics (JSON, no secrets)</a></p>
    `;
    res.send(layout({ title: 'Install YOUPI PG', body }));
  });

  app.post('/install', async (req, res) => {
    const dbHost = cleanString(req.body.db_host, 255) || 'localhost';
    const dbPort = Number(req.body.db_port || 3306);
    const dbName = cleanString(req.body.db_name, 100);
    const dbUser = cleanString(req.body.db_user, 100);
    const dbPassword = req.body.db_password || '';
    const adminName = cleanString(req.body.admin_name, 255);
    const adminEmail = cleanString(req.body.admin_email, 255);
    const adminPassword = req.body.admin_password || '';
    const confirm = req.body.admin_password_confirm || '';
    const confirmed = req.body.confirm_empty_or_checked === 'yes';

    function fail(message) {
      return res.status(400).send(layout({ title: 'Install YOUPI PG', body: alert('error', message) + '<p><a class="btn secondary" href="/install">Back to installer</a></p>' }));
    }
    if (!dbName || !dbUser || !dbPassword) return fail('Database name, user and password are required.');
    if (!isEmail(adminEmail) || !adminName) return fail('A valid admin name and email are required.');
    if (adminPassword.length < 10 || adminPassword !== confirm) return fail('Admin password must be at least 10 characters and match the confirmation.');

    let testPool;
    try {
      testPool = mysql.createPool({ host: dbHost, port: dbPort, user: dbUser, password: dbPassword, database: dbName, connectionLimit: 5, waitForConnections: true, dateStrings: true, multipleStatements: false });
      await testPool.query('SELECT 1 AS ok');
    } catch (err) {
      if (testPool) await testPool.end().catch(() => {});
      return fail(`Database connection failed: ${escapeHtml(String(err?.message || err))}. Check the host, port, database name and user in cPanel, and make sure the user is added to that database. No migration was run.`);
    }

    // Inspect existing data before migrating, as required.
    let existingSummary = '';
    let existingRows = 0;
    try {
      const [tables] = await testPool.query('SHOW TABLES');
      const names = tables.map((r) => Object.values(r)[0]);
      for (const table of ['merchants', 'orders', 'admins']) {
        if (names.includes(table)) {
          const [countRows] = await testPool.query(`SELECT COUNT(*) AS n FROM \`${table}\``);
          existingRows += Number(countRows[0]?.n || 0);
          existingSummary += `${table}: ${countRows[0]?.n || 0} rows. `;
        }
      }
      if (existingRows > 0 && !confirmed) {
        await testPool.end().catch(() => {});
        return res.status(400).send(layout({ title: 'Install YOUPI PG', body: alert('error', `This database already contains data (${existingSummary}). The installer will NOT run migrations against it until you confirm. Please go back, check the database, make a backup, tick the confirmation box, and re-enter the database password. No migration was run.`) + '<p><a class="btn secondary" href="/install">Back to installer</a></p>' }));
      }
      const installed = await isInstalled(testPool).catch(() => false);
      if (installed) {
        await testPool.end().catch(() => {});
        return res.status(403).send(layout({ title: 'Installer locked', body: alert('error', 'This database is already installed. The installer is locked and will not run again against it.') }));
      }
    } catch (err) {
      await testPool.end().catch(() => {});
      return fail(`Database inspection failed: ${escapeHtml(String(err?.message || err))}. No migration was run.`);
    }

    try {
      const results = await migrate({ config, apply: true, pool: testPool });
      const [admins] = await testPool.query('SELECT id FROM admins WHERE email = ?', [adminEmail]);
      if (admins[0]) throw new Error('An administrator with that email already exists. No admin was created and no data was erased.');
      await testPool.query(
        'INSERT INTO admins (id, email, password_hash, name, role, status) VALUES (?, ?, ?, ?, ?, ?)',
        [randomUUID(), adminEmail, hashPassword(adminPassword), adminName, 'admin', 'active'],
      );
      await setSetting(testPool, 'installed', { installed: true, installed_at: new Date().toISOString(), version: '1.0.0' });
      await setSetting(testPool, 'app_name', { value: config.appName });
      await audit(testPool, { actorType: 'admin', actorId: adminEmail, merchantId: null, entityType: 'app', entityId: 'installer', action: 'installer_completed', details: { migrations: results.map((r) => `${r.version}:${r.status}`) }, ip: req.ip });

      // Persist connection settings for local / app-folder deployments only:
      // write gateway/.env only if it does not already exist, with 0600
      // permissions, and never overwrite an existing file. On cPanel, also
      // set the same variables in the Node.js App panel for redeploys.
      const envPath = path.join(gatewayRoot, '.env');
      let envNote = '';
      try {
        if (!fs.existsSync(envPath)) {
          const sessionSecret = config.sessionSecret && !/change-me/i.test(config.sessionSecret) ? config.sessionSecret : null;
          const encryptionKey = config.encryptionKey && /^[0-9a-fA-F]{64}$/.test(config.encryptionKey) ? config.encryptionKey : null;
          const generatedSession = sessionSecret || (await import('node:crypto')).randomBytes(32).toString('hex');
          const generatedEncryption = encryptionKey || (await import('node:crypto')).randomBytes(32).toString('hex');
          // Never write a placeholder base URL into .env: if the current
          // base URL looks like a placeholder, leave it blank so the
          // hosting panel value (or a corrected value) must be set.
          const safeBaseUrl = (config.baseUrl && !/example\.com|change-me/i.test(config.baseUrl)) ? config.baseUrl : '';
          const envContent = `NODE_ENV=production\nAPP_BASE_URL=${safeBaseUrl}\nDB_HOST=${dbHost}\nDB_PORT=${dbPort}\nDB_USER=${dbUser}\nDB_PASSWORD=${dbPassword}\nDB_NAME=${dbName}\nSESSION_SECRET=${generatedSession}\nENCRYPTION_MASTER_KEY=${generatedEncryption}\nVERIFICATION_MODE=manual\n`;
          fs.writeFileSync(envPath, envContent, { mode: 0o600 });
          envNote = '<p><strong>Important:</strong> A <code>gateway/.env</code> file was created in the app folder (outside public_html, permissions 0600). For cPanel redeploys, also copy these same variables into the Node.js App panel, then restart the app. Never commit this file.</p>';
        } else {
          envNote = '<p><strong>Important:</strong> A <code>gateway/.env</code> file already existed, so it was not overwritten. Make sure the Node.js App panel contains the same database variables, then restart the app.</p>';
        }
      } catch {
        envNote = '<p><strong>Important:</strong> The installer could not write <code>gateway/.env</code>. Set the database variables in the Node.js App panel and restart the app.</p>';
      }
      await testPool.end().catch(() => {});
      return res.send(layout({ title: 'Installation complete', body: `<div class="alert success">Installation complete and locked.</div><p>Migrations: ${escapeHtml(results.map((r) => `${r.version}: ${r.status}`).join(', '))}</p><p>Administrator <strong>${escapeHtml(adminEmail)}</strong> was created. The installer will not run again against this database.</p>${envNote}<p><a class="btn" href="/admin/login">Admin login</a> <a class="btn secondary" href="/merchant/login">Merchant login</a></p>` }));
    } catch (err) {
      await testPool.end().catch(() => {});
      return fail(`Installation failed: ${escapeHtml(String(err?.message || err))}. No data was erased. Fix the cause and try again.`);
    }
  });

  // ---------- Merchant auth ----------
  app.get('/merchant/register', (req, res) => {
    res.send(layout({ title: 'Merchant registration', body: `<form method="post" action="/merchant/register">${field('Business name', 'business_name', 'text', '', 'required')}${field('Slug (lowercase, letters, numbers, hyphens)', 'slug', 'text', '', 'required')}${field('Contact email', 'contact_email', 'email', '', 'required')}${field('Contact phone', 'contact_phone', 'text', '')}${field('UPI ID', 'upi_id', 'text', '', 'required')}${field('Payee name', 'payee_name', 'text', '', 'required')}${field('Password (at least 10 characters)', 'password', 'password', '', 'required autocomplete="new-password"')}<p><button class="btn" type="submit">Register</button></p></form><p class="muted">New merchants start as pending. An administrator must approve the account before API orders can be created.</p>` }));
  });

  app.post('/merchant/register', loginLimiter, async (req, res) => {
    const pool = poolOrNull(req, res); if (!pool || res.headersSent) return;
    const businessName = cleanString(req.body.business_name, 255);
    const slug = cleanString(req.body.slug, 100).toLowerCase();
    const email = cleanString(req.body.contact_email, 255);
    const phone = cleanString(req.body.contact_phone, 20);
    const upiId = cleanString(req.body.upi_id, 255);
    const payeeName = cleanString(req.body.payee_name, 255);
    const password = req.body.password || '';
    function fail(msg) { return res.status(400).send(layout({ title: 'Merchant registration', body: alert('error', msg) + '<p><a href="/merchant/register">Back</a></p>' })); }
    if (!businessName || !isSlug(slug) || !isEmail(email) || !isUpiId(upiId) || !payeeName || password.length < 10) {
      return fail('Please check all fields: a valid slug, email, UPI ID and a password of at least 10 characters are required.');
    }
    const [existing] = await pool.query('SELECT id FROM merchants WHERE slug = ? OR contact_email = ?', [slug, email]);
    if (existing[0]) return fail('A merchant with that slug or email already exists.');
    const id = randomUUID();
    try {
      await pool.query(
        'INSERT INTO merchants (id, business_name, slug, contact_email, contact_phone, password_hash, status, upi_id, payee_name, branding) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        [id, businessName, slug, email, phone || null, hashPassword(password), 'pending', upiId, payeeName, JSON.stringify({ appName: config.appName })],
      );
      await audit(pool, { actorType: 'merchant', actorId: id, merchantId: id, entityType: 'merchant', entityId: slug, action: 'merchant_registered', details: {}, ip: req.ip });
    } catch (err) {
      return fail(`Registration failed: ${escapeHtml(String(err?.message || err))}`);
    }
    res.send(layout({ title: 'Registration received', body: '<div class="alert success">Registration received. Your account is pending approval by an administrator. You can log in to view your profile, but API orders are blocked until approval.</div><p><a class="btn" href="/merchant/login">Merchant login</a></p>' }));
  });

  app.get('/merchant/login', (req, res) => {
    res.send(layout({ title: 'Merchant login', body: `<form method="post" action="/merchant/login">${field('Email', 'email', 'email', '', 'required')}${field('Password', 'password', 'password', '', 'required')}<p><button class="btn" type="submit">Log in</button></p></form><p><a href="/merchant/forgot-password">Forgot password?</a> · <a href="/merchant/register">Register</a></p>` }));
  });

  app.post('/merchant/login', loginLimiter, async (req, res) => {
    const pool = poolOrNull(req, res); if (!pool || res.headersSent) return;
    const [rows] = await pool.query('SELECT * FROM merchants WHERE contact_email = ?', [cleanString(req.body.email, 255)]);
    const merchant = rows[0];
    if (!merchant || !verifyPassword(req.body.password || '', merchant.password_hash)) {
      return res.status(401).send(layout({ title: 'Merchant login', body: alert('error', 'Invalid email or password.') + '<p><a href="/merchant/login">Try again</a></p>' }));
    }
    const session = await createSession(pool, 'merchant', merchant.id, req.ip, req.headers['user-agent']);
    res.cookie('gw_session', session.token, sessionCookieOptions(config));
    await audit(pool, { actorType: 'merchant', actorId: merchant.id, merchantId: merchant.id, entityType: 'merchant', entityId: merchant.slug, action: 'merchant_login', details: {}, ip: req.ip });
    res.redirect('/merchant/dashboard');
  });

  app.get('/merchant/logout', async (req, res) => {
    const pool = poolOverride || (config.db.configured ? getPool(config) : null);
    const token = req.headers.cookie?.split(';').map((c) => c.trim()).find((c) => c.startsWith('gw_session='))?.slice('gw_session='.length);
    if (pool && token) await deleteSession(pool, decodeURIComponent(token));
    res.clearCookie('gw_session', { path: '/' });
    res.redirect('/');
  });

  async function requireMerchant(req, res, next) {
    const auth = await merchantFromCookie(req);
    if (!auth) return res.redirect('/merchant/login');
    req.merchant = auth.merchant;
    req.merchantSession = auth.session;
    req.merchantToken = auth.token;
    req.csrf = csrfTokenFor(auth.token, config.sessionSecret);
    return next();
  }

  app.get('/merchant/dashboard', requireMerchant, async (req, res) => {
    const pool = poolOrNull(req, res); if (!pool || res.headersSent) return;
    const m = req.merchant;
    const [stats] = await pool.query(
      "SELECT status, COUNT(*) AS n, COALESCE(SUM(amount_paise), 0) AS total FROM orders WHERE merchant_id = ? GROUP BY status",
      [m.id],
    );
    const byStatus = {};
    let totalOrders = 0;
    let successTotal = 0;
    for (const row of stats) { byStatus[row.status] = Number(row.n); totalOrders += Number(row.n); if (row.status === 'success') successTotal = Number(row.total); }
    const [recent] = await pool.query('SELECT * FROM orders WHERE merchant_id = ? ORDER BY created_at DESC LIMIT 10', [m.id]);
    const [keys] = await pool.query('SELECT COUNT(*) AS n FROM merchant_api_keys WHERE merchant_id = ? AND status = ?', [m.id, 'active']);
    const subCurrent = await getCurrentSubscription(pool, m.id).catch(() => ({ plan: null, subscription: null, isGrace: false, isExpired: false }));
    const subUsage = await getUsage(pool, m.id).catch(() => ({ ordersThisMonth: 0, apiOrdersThisMonth: 0 }));
    const emailVerified = await isEmailVerified(pool, m.id).catch(() => false);
    const onboarding = [
      { done: Boolean(m.upi_id && m.payee_name), text: 'Profile complete: UPI ID and payee name set', href: '/merchant/profile' },
      { done: emailVerified, text: 'Email verified', href: '/merchant/security' },
      { done: Number(keys[0]?.n || 0) > 0, text: 'API key created', href: '/merchant/api-keys' },
      { done: Boolean(m.webhook_url), text: 'Webhook URL configured', href: '/merchant/webhooks' },
      { done: totalOrders > 0, text: 'First order created', href: '/merchant/orders/new' },
      { done: m.status === 'approved', text: 'Account approved by an administrator', href: '/merchant/dashboard' },
    ];
    const subPlanName = subCurrent.plan ? (subCurrent.plan.plan_name || subCurrent.plan.name) : '—';
    const body = `
      ${m.status !== 'approved' ? `<div class="alert info">Account status: <strong>${escapeHtml(m.status)}</strong>. ${m.status === 'pending' ? 'An administrator must approve your account before orders can be created (from the dashboard or the API).' : 'This account is suspended. Contact the administrator.'}</div>` : ''}
      ${subCurrent.isGrace ? '<div class="alert info">Your subscription is in its grace period. Renew or change your plan before grace ends.</div>' : ''}
      ${subCurrent.isExpired ? '<div class="alert error">Your subscription has expired and grace has ended. New order creation is blocked until you renew or change your plan.</div>' : ''}
      <div class="grid">
        <div class="card"><h3>Subscription</h3><p class="big">${escapeHtml(subPlanName)}</p><p>Status: ${escapeHtml(subCurrent.subscription ? subCurrent.subscription.status : 'Free (no subscription record)')} · Orders this month: ${subUsage.ordersThisMonth}</p><p><a class="btn secondary" href="/merchant/subscription">Manage subscription</a></p></div>
        <div class="card"><h3>Onboarding checklist</h3><ul>${onboarding.map((o) => `<li>${o.done ? '✓' : '○'} ${escapeHtml(o.text)} ${o.done ? '' : `— <a href="${o.href}">Complete</a>`}</li>`).join('')}</ul></div>
      </div>
      <div class="grid">
        <div class="card"><h3>Total orders</h3><p class="big">${totalOrders}</p></div>
        <div class="card"><h3>Successful revenue</h3><p class="big">${formatPaise(successTotal)}</p></div>
        <div class="card"><h3>Pending</h3><p class="big">${byStatus.pending || 0}</p></div>
        <div class="card"><h3>Processing</h3><p class="big">${byStatus.processing || 0}</p></div>
        <div class="card"><h3>Active API keys</h3><p class="big">${keys[0]?.n || 0}</p></div>
      </div>
      <p><strong>UPI ID:</strong> ${escapeHtml(m.upi_id || '—')} &nbsp; <strong>Payee:</strong> ${escapeHtml(m.payee_name || '—')}</p>
      <h2>Recent orders</h2>
      ${ordersTable(recent, { detailBase: '/merchant/orders' })}
      <p><a class="btn" href="/merchant/orders/new">Create payment link</a> <a class="btn secondary" href="/merchant/orders">All orders</a> <a class="btn secondary" href="/merchant/api-keys">API keys</a> <a class="btn secondary" href="/merchant/docs">Integration docs</a></p>
    `;
    res.send(layout({ title: 'Merchant dashboard', body, user: { label: `${m.business_name} (${m.status})`, logout: '/merchant/logout' }, nav: merchantNav() }));
  });

  app.get('/merchant/orders', requireMerchant, async (req, res) => {
    const pool = poolOrNull(req, res); if (!pool || res.headersSent) return;
    const { page, perPage, offset } = pagination(req.query);
    const q = cleanString(req.query.q || '', 100);
    const status = cleanString(req.query.status || '', 20);
    const where = ['merchant_id = ?'];
    const params = [req.merchant.id];
    if (q) { where.push('(gateway_reference LIKE ? OR merchant_order_id LIKE ? OR verification_utr LIKE ?)'); params.push(`%${q}%`, `%${q}%`, `%${q}%`); }
    if (status) { where.push('status = ?'); params.push(status); }
    const [orders] = await pool.query(`SELECT * FROM orders WHERE ${where.join(' AND ')} ORDER BY created_at DESC LIMIT ? OFFSET ?`, [...params, perPage + 1, offset]);
    const hasMore = orders.length > perPage;
    const shown = hasMore ? orders.slice(0, perPage) : orders;
    const base = `/merchant/orders?q=${encodeURIComponent(q)}&status=${encodeURIComponent(status)}`;
    const body = `
      <p><a class="btn" href="/merchant/orders/new">Create payment link</a></p>
      <form method="get" action="/merchant/orders" class="inline-form"><input name="q" value="${escapeHtml(q)}" placeholder="Search reference, order ID or UTR"><select name="status"><option value="">All statuses</option>${['pending', 'processing', 'success', 'failed', 'expired', 'cancelled', 'refunded'].map((s) => `<option value="${s}" ${status === s ? 'selected' : ''}>${s}</option>`).join('')}</select><button type="submit">Filter</button></form>
      ${ordersTable(shown, { detailBase: '/merchant/orders' })}
      ${paginationLinks(base, page, perPage, hasMore)}
    `;
    res.send(layout({ title: 'Orders', body, user: { label: req.merchant.business_name, logout: '/merchant/logout' }, nav: merchantNav() }));
  });

  // Dashboard order creation (payment links). This is the same order
  // model as the API: same UPI ID, same amount validation, same
  // checkout expiry, same pending state. It never marks an order
  // successful — the customer still pays on the checkout page and the
  // order is verified afterwards (manual, observer or provider).
  // This route must stay before '/merchant/orders/:ref', or "new"
  // would be treated as an order reference.
  app.get('/merchant/orders/new', requireMerchant, async (req, res) => {
    const m = req.merchant;
    if (m.status !== 'approved') {
      return res.send(layout({ title: 'Create payment link', body: `<div class="alert info">Account status: <strong>${escapeHtml(m.status)}</strong>. An administrator must approve your account before orders can be created.</div><p><a class="btn secondary" href="/merchant/dashboard">Back to dashboard</a></p>`, user: { label: m.business_name, logout: '/merchant/logout' }, nav: merchantNav() }));
    }
    const body = `<form method="post" action="/merchant/orders">${csrfField(req.csrf)}${field('Merchant order ID (leave blank to auto-generate)', 'merchant_order_id', 'text', '')}${field('Amount (₹, e.g. 499.00)', 'amount_rupees', 'text', '', 'required')}${field('Customer name', 'customer_name', 'text', '')}${field('Customer email', 'customer_email', 'email', '')}${field('Customer phone', 'customer_phone', 'text', '')}${field('Return URL after payment (https, optional)', 'return_url', 'text', '')}<label>Mode<select name="mode"><option value="live">Live</option><option value="sandbox">Sandbox (test only, no real money)</option></select></label><p class="muted">Currency is always INR. The customer pays on the checkout page with a UPI QR code and deep link. This form does not mark anything as paid.</p><p><button class="btn" type="submit">Create payment link</button></p></form>`;
    res.send(layout({ title: 'Create payment link', body, user: { label: m.business_name, logout: '/merchant/logout' }, nav: merchantNav() }));
  });

  app.post('/merchant/orders', requireMerchant, requireCsrf, async (req, res) => {
    const pool = poolOrNull(req, res); if (!pool || res.headersSent) return;
    const merchant = req.merchant;
    if (merchant.status !== 'approved') {
      return res.status(403).send(layout({ title: 'Create payment link', body: `<div class="alert error">Merchant account is ${escapeHtml(merchant.status)}. Orders require an approved account.</div>`, user: { label: merchant.business_name, logout: '/merchant/logout' }, nav: merchantNav() }));
    }
    const allowed = await checkOrderAllowed(pool, merchant, 'dashboard').catch(() => ({ allowed: true }));
    if (!allowed.allowed) {
      return res.status(403).send(layout({ title: 'Create payment link', body: `<div class="alert error">${escapeHtml(allowed.reason)}</div><p><a href="/merchant/subscription">Manage subscription</a></p>`, user: { label: merchant.business_name, logout: '/merchant/logout' }, nav: merchantNav() }));
    }
    const amountPaise = parseRupeesToPaise(String(req.body.amount_rupees || ''));
    const customerEmail = cleanString(req.body.customer_email || '', 255);
    const returnUrlRaw = cleanString(req.body.return_url || '', 1024);
    const returnUrl = validateReturnUrl(returnUrlRaw);
    if (!amountPaise) {
      return res.status(400).send(layout({ title: 'Create payment link', body: `<div class="alert error">Enter a positive amount in rupees (e.g. 499.00).</div><p><a href="/merchant/orders/new">Back</a></p>`, user: { label: merchant.business_name, logout: '/merchant/logout' }, nav: merchantNav() }));
    }
    if (customerEmail && !isEmail(customerEmail)) {
      return res.status(400).send(layout({ title: 'Create payment link', body: `<div class="alert error">Customer email is not valid.</div><p><a href="/merchant/orders/new">Back</a></p>`, user: { label: merchant.business_name, logout: '/merchant/logout' }, nav: merchantNav() }));
    }
    if (returnUrlRaw && returnUrl === null) {
      return res.status(400).send(layout({ title: 'Create payment link', body: `<div class="alert error">Return URL must be a valid http:// or https:// URL.</div><p><a href="/merchant/orders/new">Back</a></p>`, user: { label: merchant.business_name, logout: '/merchant/logout' }, nav: merchantNav() }));
    }
    let merchantOrderId = cleanString(req.body.merchant_order_id || '', 255);
    if (!merchantOrderId) {
      const day = new Date().toISOString().slice(0, 10).replace(/-/g, '');
      merchantOrderId = `WEB-${day}-${Math.floor(100000 + Math.random() * 900000)}`;
    }
    const [dup] = await pool.query('SELECT * FROM orders WHERE merchant_id = ? AND merchant_order_id = ?', [merchant.id, merchantOrderId]);
    if (dup[0]) {
      return res.status(409).send(layout({ title: 'Create payment link', body: `<div class="alert error">Merchant order ID already exists for this merchant. Use a different order ID.</div><p><a href="/merchant/orders/new">Back</a></p>`, user: { label: merchant.business_name, logout: '/merchant/logout' }, nav: merchantNav() }));
    }
    const upiId = merchant.upi_id;
    if (!upiId) {
      return res.status(400).send(layout({ title: 'Create payment link', body: `<div class="alert error">Merchant UPI ID is not configured. Set it on your profile first.</div><p><a href="/merchant/profile">Profile</a></p>`, user: { label: merchant.business_name, logout: '/merchant/logout' }, nav: merchantNav() }));
    }
    const mode = req.body.mode === 'sandbox' ? 'sandbox' : 'live';
    const [accounts] = await pool.query('SELECT * FROM receiving_accounts WHERE merchant_id = ? AND upi_id = ? AND is_active = 1', [merchant.id, upiId]);
    const gatewayReference = generateGatewayReference();
    const id = randomUUID();
    await pool.query(
      'INSERT INTO orders (id, merchant_id, merchant_order_id, gateway_reference, receiving_account_id, amount_paise, currency, status, method, upi_id_used, customer_name, customer_email, customer_phone, return_url, metadata, verification_source, mode, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, DATE_ADD(UTC_TIMESTAMP(), INTERVAL ? MINUTE))',
      [id, merchant.id, merchantOrderId, gatewayReference, accounts[0]?.id || null, amountPaise, 'INR', 'pending', 'upi', upiId, cleanString(req.body.customer_name || '', 255) || null, customerEmail || null, cleanString(req.body.customer_phone || '', 20) || null, returnUrl || null, JSON.stringify({}), 'none', mode, CHECKOUT_EXPIRY_MINUTES],
    );
    const [fresh] = await pool.query('SELECT * FROM orders WHERE id = ?', [id]);
    await addOrderEvent(pool, { orderId: id, eventType: 'order_created', statusFrom: null, statusTo: 'pending', source: 'dashboard', actorType: 'merchant', actorId: merchant.id, details: { mode } });
    await audit(pool, { actorType: 'merchant', actorId: merchant.id, merchantId: merchant.id, entityType: 'order', entityId: gatewayReference, action: 'order_created_dashboard', details: { mode, amount_paise: amountPaise }, ip: req.ip });
    res.redirect(`/merchant/orders/${gatewayReference}`);
  });

  app.get('/merchant/orders/:ref', requireMerchant, async (req, res) => {
    const pool = poolOrNull(req, res); if (!pool || res.headersSent) return;
    const [rows] = await pool.query('SELECT * FROM orders WHERE gateway_reference = ? AND merchant_id = ?', [req.params.ref, req.merchant.id]);
    const order = rows[0];
    if (!order) return res.status(404).send(layout({ title: 'Order not found', body: '<p>Order not found or it does not belong to your account.</p>' }));
    const [events] = await pool.query('SELECT * FROM order_events WHERE order_id = ? ORDER BY created_at ASC', [order.id]);
    const [deliveries] = await pool.query('SELECT * FROM webhook_deliveries WHERE order_id = ? ORDER BY created_at DESC', [order.id]);
    const body = `
      <p><strong>Merchant order:</strong> ${escapeHtml(order.merchant_order_id)} &nbsp; <strong>Reference:</strong> ${escapeHtml(order.gateway_reference)} &nbsp; <strong>Mode:</strong> ${escapeHtml(order.mode || 'live')}</p>
      <p><strong>Amount:</strong> ${formatPaise(order.amount_paise)} &nbsp; <strong>Status:</strong> ${statusBadge(order.status)} &nbsp; <strong>Verified by:</strong> ${escapeHtml(order.verification_source || 'none')} &nbsp; <strong>UTR:</strong> ${escapeHtml(order.verification_utr || '—')}</p>
      <p><strong>Customer:</strong> ${escapeHtml(order.customer_name || '—')} &nbsp; <strong>Checkout:</strong> <a href="/checkout/${escapeHtml(order.gateway_reference)}">/checkout/${escapeHtml(order.gateway_reference)}</a></p>
      <h2>Events</h2>
      ${events.length ? `<table><thead><tr><th>Event</th><th>From</th><th>To</th><th>Source</th><th>When</th></tr></thead><tbody>${events.map((e) => `<tr><td>${escapeHtml(e.event_type)}</td><td>${escapeHtml(e.status_from || '—')}</td><td>${escapeHtml(e.status_to || '—')}</td><td>${escapeHtml(e.source || '—')}</td><td>${formatDate(e.created_at)}</td></tr>`).join('')}</tbody></table>` : '<p class="muted">No events yet.</p>'}
      <h2>Webhook deliveries</h2>
      ${deliveries.length ? `<table><thead><tr><th>Event</th><th>Endpoint</th><th>Status</th><th>Attempts</th><th>When</th></tr></thead><tbody>${deliveries.map((d) => `<tr><td>${escapeHtml(d.event_type)}</td><td>${escapeHtml(d.endpoint_url)}</td><td>${d.is_successful ? 'delivered' : 'pending/failed'} (${d.response_status || '—'})</td><td>${d.attempt_count}</td><td>${formatDate(d.created_at)}</td></tr>`).join('')}</tbody></table>` : '<p class="muted">No webhook deliveries for this order.</p>'}
    `;
    res.send(layout({ title: `Order ${order.gateway_reference}`, body, user: { label: req.merchant.business_name, logout: '/merchant/logout' }, nav: merchantNav() }));
  });

  app.get('/merchant/profile', requireMerchant, async (req, res) => {
    const m = req.merchant;
    const body = `<form method="post" action="/merchant/profile">${csrfField(req.csrf)}${field('Business name', 'business_name', 'text', m.business_name, 'required')}${field('Contact email', 'contact_email', 'email', m.contact_email, 'required')}${field('Contact phone', 'contact_phone', 'text', m.contact_phone || '')}${field('UPI ID', 'upi_id', 'text', m.upi_id || '', 'required')}${field('Payee name', 'payee_name', 'text', m.payee_name || '', 'required')}<p><button class="btn" type="submit">Save profile</button></p></form>`;
    res.send(layout({ title: 'Merchant profile', body, user: { label: m.business_name, logout: '/merchant/logout' }, nav: merchantNav() }));
  });

  app.post('/merchant/profile', requireMerchant, requireCsrf, async (req, res) => {
    const pool = poolOrNull(req, res); if (!pool || res.headersSent) return;
    const businessName = cleanString(req.body.business_name, 255);
    const email = cleanString(req.body.contact_email, 255);
    const phone = cleanString(req.body.contact_phone, 20);
    const upiId = cleanString(req.body.upi_id, 255);
    const payeeName = cleanString(req.body.payee_name, 255);
    if (!businessName || !isEmail(email) || !isUpiId(upiId) || !payeeName) {
      return res.status(400).send(layout({ title: 'Merchant profile', body: alert('error', 'Please check business name, email, UPI ID and payee name.') }));
    }
    await pool.query('UPDATE merchants SET business_name = ?, contact_email = ?, contact_phone = ?, upi_id = ?, payee_name = ? WHERE id = ?', [businessName, email, phone || null, upiId, payeeName, req.merchant.id]);
    await audit(pool, { actorType: 'merchant', actorId: req.merchant.id, merchantId: req.merchant.id, entityType: 'merchant', entityId: req.merchant.slug, action: 'merchant_profile_updated', details: { upi_id: upiId }, ip: req.ip });
    res.redirect('/merchant/dashboard');
  });

  app.get('/merchant/api-keys', requireMerchant, async (req, res) => {
    const pool = poolOrNull(req, res); if (!pool || res.headersSent) return;
    const [keys] = await pool.query('SELECT id, key_prefix, key_type, public_value, name, status, last_used_at, created_at, revoked_at FROM merchant_api_keys WHERE merchant_id = ? ORDER BY created_at DESC', [req.merchant.id]);
    const shownKey = req.query.new_key ? `<div class="alert success">New ${escapeHtml(req.query.new_key_type || 'secret')} key — copy it now. A secret key is shown only once and cannot be retrieved again: <code>${escapeHtml(req.query.new_key)}</code></div>` : '';
    const body = `${shownKey}
      <form method="post" action="/merchant/api-keys">${csrfField(req.csrf)}<label>Key name<input name="name" placeholder="e.g. Website production"></label><label>Type<select name="key_type"><option value="secret">Secret (for server-side API calls)</option><option value="public">Public (publishable, for SDK identification)</option></select></label><p><button class="btn" type="submit">Create API key</button></p></form>
      <p class="muted"><strong>Never put a secret key in browser JavaScript, HTML, or a mobile app.</strong> Secret keys belong on your server only. Public keys may be used in the browser to identify your merchant account.</p>
      ${keys.length ? `<table><thead><tr><th>Prefix</th><th>Type</th><th>Name</th><th>Public value</th><th>Status</th><th>Last used</th><th>Created</th><th>Actions</th></tr></thead><tbody>${keys.map((k) => `<tr><td><code>${escapeHtml(k.key_prefix)}</code></td><td>${escapeHtml(k.key_type)}</td><td>${escapeHtml(k.name || '—')}</td><td>${escapeHtml(k.public_value || '—')}</td><td>${escapeHtml(k.status)}</td><td>${formatDate(k.last_used_at)}</td><td>${formatDate(k.created_at)}</td><td>${k.status === 'active' ? `<form method="post" action="/merchant/api-keys/${escapeHtml(k.id)}/revoke" style="display:inline">${csrfField(req.csrf)}<button type="submit">Revoke</button></form> <form method="post" action="/merchant/api-keys/${escapeHtml(k.id)}/rotate" style="display:inline">${csrfField(req.csrf)}<button type="submit">Rotate</button></form>` : '—'}</td></tr>`).join('')}</tbody></table>` : '<p class="muted">No API keys yet.</p>'}
    `;
    res.send(layout({ title: 'API keys', body, user: { label: req.merchant.business_name, logout: '/merchant/logout' }, nav: merchantNav() }));
  });

  app.post('/merchant/api-keys', requireMerchant, requireCsrf, async (req, res) => {
    const pool = poolOrNull(req, res); if (!pool || res.headersSent) return;
    const type = req.body.key_type === 'public' ? 'public' : 'secret';
    const name = cleanString(req.body.name, 100);
    const generated = generateApiKey(type);
    await pool.query(
      'INSERT INTO merchant_api_keys (id, merchant_id, key_prefix, key_hash, key_type, public_value, name, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      [randomUUID(), req.merchant.id, generated.prefix, generated.hash, type, type === 'public' ? generated.value : null, name || null, 'active'],
    );
    await audit(pool, { actorType: 'merchant', actorId: req.merchant.id, merchantId: req.merchant.id, entityType: 'api_key', entityId: generated.prefix, action: 'api_key_created', details: { type }, ip: req.ip });
    res.redirect(`/merchant/api-keys?new_key=${encodeURIComponent(generated.value)}&new_key_type=${type}`);
  });

  async function revokeKey(pool, merchantId, keyId) {
    const [rows] = await pool.query('SELECT * FROM merchant_api_keys WHERE id = ? AND merchant_id = ?', [keyId, merchantId]);
    if (!rows[0] || rows[0].status !== 'active') return false;
    await pool.query('UPDATE merchant_api_keys SET status = ?, revoked_at = UTC_TIMESTAMP() WHERE id = ?', ['revoked', keyId]);
    return true;
  }

  app.post('/merchant/api-keys/:id/revoke', requireMerchant, requireCsrf, async (req, res) => {
    const pool = poolOrNull(req, res); if (!pool || res.headersSent) return;
    await revokeKey(pool, req.merchant.id, req.params.id);
    await audit(pool, { actorType: 'merchant', actorId: req.merchant.id, merchantId: req.merchant.id, entityType: 'api_key', entityId: req.params.id, action: 'api_key_revoked', details: {}, ip: req.ip });
    res.redirect('/merchant/api-keys');
  });

  app.post('/merchant/api-keys/:id/rotate', requireMerchant, requireCsrf, async (req, res) => {
    const pool = poolOrNull(req, res); if (!pool || res.headersSent) return;
    const [rows] = await pool.query('SELECT * FROM merchant_api_keys WHERE id = ? AND merchant_id = ?', [req.params.id, req.merchant.id]);
    const old = rows[0];
    if (!old || old.status !== 'active') return res.redirect('/merchant/api-keys');
    const generated = generateApiKey(old.key_type);
    await pool.query(
      'INSERT INTO merchant_api_keys (id, merchant_id, key_prefix, key_hash, key_type, public_value, name, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      [randomUUID(), req.merchant.id, generated.prefix, generated.hash, old.key_type, old.key_type === 'public' ? generated.value : null, old.name, 'active'],
    );
    await revokeKey(pool, req.merchant.id, req.params.id);
    await audit(pool, { actorType: 'merchant', actorId: req.merchant.id, merchantId: req.merchant.id, entityType: 'api_key', entityId: generated.prefix, action: 'api_key_rotated', details: { oldPrefix: old.key_prefix }, ip: req.ip });
    res.redirect(`/merchant/api-keys?new_key=${encodeURIComponent(generated.value)}&new_key_type=${old.key_type}`);
  });

  app.get('/merchant/webhooks', requireMerchant, async (req, res) => {
    const pool = poolOrNull(req, res); if (!pool || res.headersSent) return;
    const { page, perPage, offset } = pagination(req.query);
    const [deliveries] = await pool.query('SELECT * FROM webhook_deliveries WHERE merchant_id = ? ORDER BY created_at DESC LIMIT ? OFFSET ?', [req.merchant.id, perPage + 1, offset]);
    const hasMore = deliveries.length > perPage;
    const shown = hasMore ? deliveries.slice(0, perPage) : deliveries;
    const body = `
      <form method="post" action="/merchant/webhooks">${csrfField(req.csrf)}${field('Webhook URL (https in production)', 'webhook_url', 'text', req.merchant.webhook_url || '')}<p><button class="btn" type="submit">Save webhook URL</button></p></form>
      <form method="post" action="/merchant/webhooks/secret">${csrfField(req.csrf)}<p><button class="btn secondary" type="submit">Generate new webhook secret</button> <span class="muted">The secret is encrypted at rest and shown once below after generation. Update your receiver with the new secret immediately; old signatures will stop verifying.</span></p></form>
      ${req.query.new_secret ? `<div class="alert success">New webhook secret (copy now, it is shown only once): <code>${escapeHtml(req.query.new_secret)}</code></div>` : ''}
      <h2>Delivery logs</h2>
      ${shown.length ? `<table><thead><tr><th>Event</th><th>Endpoint</th><th>Delivery</th><th>Status</th><th>Attempts</th><th>Next retry</th><th>When</th><th>Action</th></tr></thead><tbody>${shown.map((d) => `<tr><td>${escapeHtml(d.event_type)}</td><td>${escapeHtml(d.endpoint_url)}</td><td><code>${escapeHtml(d.delivery_id)}</code></td><td>${d.is_successful ? 'delivered' : 'pending/failed'} (${d.response_status || '—'})</td><td>${d.attempt_count}</td><td>${formatDate(d.next_retry_at)}</td><td>${formatDate(d.created_at)}</td><td>${!d.is_successful ? `<form method="post" action="/merchant/webhooks/${escapeHtml(d.id)}/retry">${csrfField(req.csrf)}<button type="submit">Retry now</button></form>` : '—'}</td></tr>`).join('')}</tbody></table>${paginationLinks('/merchant/webhooks?', page, perPage, hasMore)}` : '<p class="muted">No webhook deliveries yet.</p>'}
    `;
    res.send(layout({ title: 'Webhooks', body, user: { label: req.merchant.business_name, logout: '/merchant/logout' }, nav: merchantNav() }));
  });

  app.post('/merchant/webhooks', requireMerchant, requireCsrf, async (req, res) => {
    const pool = poolOrNull(req, res); if (!pool || res.headersSent) return;
    const url = cleanString(req.body.webhook_url, 1024);
    if (url) {
      const check = isSafeWebhookUrl(url, { isProduction: config.isProduction });
      if (!check.valid) return res.status(400).send(layout({ title: 'Webhooks', body: alert('error', check.error) }));
    }
    await pool.query('UPDATE merchants SET webhook_url = ? WHERE id = ?', [url || null, req.merchant.id]);
    await audit(pool, { actorType: 'merchant', actorId: req.merchant.id, merchantId: req.merchant.id, entityType: 'merchant', entityId: req.merchant.slug, action: 'webhook_url_updated', details: { url }, ip: req.ip });
    res.redirect('/merchant/webhooks');
  });

  app.post('/merchant/webhooks/secret', requireMerchant, requireCsrf, async (req, res) => {
    const pool = poolOrNull(req, res); if (!pool || res.headersSent) return;
    const secret = generateWebhookSecret();
    let encrypted;
    try {
      encrypted = encryptAtRest(secret, config.encryptionKey);
    } catch {
      return res.status(500).send(layout({ title: 'Webhooks', body: alert('error', 'Webhook secret encryption failed: ENCRYPTION_MASTER_KEY must be exactly 64 hex characters. Set it in the hosting environment and try again.') }));
    }
    await pool.query('UPDATE merchants SET webhook_secret_encrypted = ? WHERE id = ?', [encrypted, req.merchant.id]);
    await audit(pool, { actorType: 'merchant', actorId: req.merchant.id, merchantId: req.merchant.id, entityType: 'merchant', entityId: req.merchant.slug, action: 'webhook_secret_rotated', details: {}, ip: req.ip });
    res.redirect(`/merchant/webhooks?new_secret=${encodeURIComponent(secret)}`);
  });

  app.post('/merchant/webhooks/:id/retry', requireMerchant, requireCsrf, async (req, res) => {
    const pool = poolOrNull(req, res); if (!pool || res.headersSent) return;
    const [rows] = await pool.query('SELECT * FROM webhook_deliveries WHERE id = ? AND merchant_id = ?', [req.params.id, req.merchant.id]);
    if (rows[0] && !rows[0].is_successful) {
      await pool.query('UPDATE webhook_deliveries SET next_retry_at = UTC_TIMESTAMP() WHERE id = ?', [req.params.id]);
      await retryDueDeliveries(pool, config, { limit: 1 }).catch(() => {});
    }
    res.redirect('/merchant/webhooks');
  });

  app.get('/merchant/docs', requireMerchant, async (req, res) => {
    const m = req.merchant;
    const base = config.baseUrl || '';
    const body = `
      <h2>1. Create an order from your server (never from the browser)</h2>
      <p>Use a <strong>secret</strong> API key. Send it as <code>Authorization: Bearer sk_...</code>. Never put a secret key in HTML or JavaScript.</p>
      <pre><code>curl -X POST ${escapeHtml(base)}/api/v1/orders \\
  -H "Authorization: Bearer sk_YOUR_SECRET_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{"merchant_order_id":"ORDER-1001","amount_paise":49900,"currency":"INR","mode":"live","return_url":"https://yourstore.example/order-done"}'</code></pre>
      <p>Response includes <code>gateway_reference</code> and <code>checkout_url</code>. Redirect the customer to <code>checkout_url</code>, or open it with the SDK below.</p>
      <h2>2. JavaScript SDK</h2>
      <pre><code>&lt;script src="${escapeHtml(base)}/public/sdk.js"&gt;&lt;/script&gt;
&lt;script&gt;
  // checkoutUrl comes from YOUR server, which created the order with a secret key.
  YoupiCheckout.open(checkoutUrl);
&lt;/script&gt;</code></pre>
      <h2>3. Webhooks (authoritative)</h2>
      <p>Browser events are for UI only. Fulfil orders only after verifying a webhook: compute HMAC-SHA256 over the <strong>raw request body</strong> with your webhook secret, compare it in constant time with <code>X-Gateway-Signature</code> (<code>sha256=&lt;hex&gt;</code>), check <code>X-Gateway-Timestamp</code> is recent (within 5 minutes), and treat <code>X-Gateway-Delivery-Id</code> as an idempotency key — process each delivery id only once. Check <code>status</code> and <code>verificationSource</code> in the payload; a sandbox order is a test, not a real payment.</p>
      <pre><code>// Node.js (Express) — use express.raw for this route
const expected = 'sha256=' + crypto.createHmac('sha256', webhookSecret).update(req.body).digest('hex');
if (!crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) return res.status(401).end();</code></pre>
      <h2>4. Your account</h2>
      <p><strong>UPI ID:</strong> ${escapeHtml(m.upi_id || '—')} &nbsp; <strong>Payee:</strong> ${escapeHtml(m.payee_name || '—')} &nbsp; <strong>Status:</strong> ${escapeHtml(m.status)} &nbsp; <strong>Webhook URL:</strong> ${escapeHtml(m.webhook_url || 'not set')}</p>
      <p class="muted">Verification sources: <code>manual</code> = admin reconciliation against a bank record; <code>observer</code> = optional external observer (Android/Gmail) matched by amount, merchant and fingerprint; <code>provider</code> = configured provider webhook only — if no provider is configured, this source never appears and orders stay pending until manually verified.</p>
    `;
    res.send(layout({ title: 'Integration docs', body, user: { label: m.business_name, logout: '/merchant/logout' }, nav: merchantNav() }));
  });

  // ---------- Merchant subscription, security, activity ----------
  app.get('/merchant/subscription', requireMerchant, async (req, res) => {
    const pool = poolOrNull(req, res); if (!pool || res.headersSent) return;
    const current = await getCurrentSubscription(pool, req.merchant.id);
    const usage = await getUsage(pool, req.merchant.id);
    let history = [];
    try {
      const [rows] = await pool.query('SELECT ms.*, p.name AS plan_name FROM merchant_subscriptions ms JOIN subscription_plans p ON p.id = ms.plan_id WHERE ms.merchant_id = ? ORDER BY ms.created_at DESC LIMIT 20', [req.merchant.id]);
      history = rows;
    } catch { history = []; }
    const plan = current.plan;
    const body = `
      ${current.tablesMissing ? '<div class="alert info">Subscription tables are not installed yet on this database. Ask an administrator to run pending migrations from Admin &gt; Settings. Until then, the Free defaults below are shown for reference only.</div>' : ''}
      ${current.isGrace ? '<div class="alert info">Your subscription is in its grace period. Renew or change your plan before grace ends, or new order creation will be blocked.</div>' : ''}
      ${current.isExpired ? '<div class="alert error">Your subscription has expired and the grace period has ended. New order creation is blocked until you renew or change your plan.</div>' : ''}
      <div class="grid">
        <div class="card"><h3>Current plan</h3><p class="big">${escapeHtml(plan ? (plan.plan_name || plan.name) : '—')}</p><p>Status: ${escapeHtml(current.subscription ? current.subscription.status : 'Free (no subscription record)')} · Payment: ${escapeHtml(current.subscription ? current.subscription.payment_status : 'not_required')}</p><p>${current.subscription ? `Started: ${formatDate(current.subscription.started_at)} · Renews: ${formatDate(current.subscription.renews_at)} · Expires: ${formatDate(current.subscription.expires_at)} · Grace until: ${formatDate(current.subscription.grace_until)}` : 'Free plan: no expiry date in this installation.'}</p></div>
        <div class="card"><h3>Usage this month</h3><p>Orders: ${usage.ordersThisMonth} / ${plan && plan.transaction_limit !== null && plan.transaction_limit !== undefined ? escapeHtml(String(plan.transaction_limit)) : 'Unlimited'}</p><p>API orders: ${usage.apiOrdersThisMonth} / ${plan && plan.api_limit !== null && plan.api_limit !== undefined ? escapeHtml(String(plan.api_limit)) : 'Unlimited'}</p></div>
      </div>
      <p><a class="btn" href="/merchant/subscription/change">Change plan</a> <a class="btn secondary" href="/pricing">See all plans</a></p>
      <p class="muted">Subscription billing is separate from the payments your customers make to you. A subscription record alone is not proof that the subscription fee was paid. Paid plans become active only after an administrator verifies the subscription payment through manual billing (or a configured provider confirmation, which is not included here).</p>
      <h2>Billing history</h2>
      ${history.length ? `<table><thead><tr><th>Plan</th><th>Cycle</th><th>Price</th><th>Status</th><th>Payment</th><th>Reference</th><th>Started</th><th>Expires</th></tr></thead><tbody>${history.map((s) => `<tr><td>${escapeHtml(s.plan_name)}</td><td>${escapeHtml(s.billing_cycle)}</td><td>${formatPaise(s.plan_price_paise)}</td><td>${escapeHtml(s.status)}</td><td>${escapeHtml(s.payment_status)}</td><td>${escapeHtml(s.billing_reference || '—')}</td><td>${formatDate(s.started_at)}</td><td>${formatDate(s.expires_at)}</td></tr>`).join('')}</tbody></table>` : '<p class="muted">No subscription records yet. You are on the Free defaults until you choose a plan.</p>'}
    `;
    res.send(layout({ title: 'Subscription', body, user: { label: req.merchant.business_name, logout: '/merchant/logout' }, nav: merchantNav() }));
  });

  app.get('/merchant/subscription/change', requireMerchant, async (req, res) => {
    const pool = poolOrNull(req, res); if (!pool || res.headersSent) return;
    let plans = [];
    try { plans = await getActivePlans(pool); } catch { plans = []; }
    if (!plans.length) plans = FALLBACK_PLANS;
    const current = await getCurrentSubscription(pool, req.merchant.id);
    const currentSlug = current.plan ? (current.plan.plan_slug || current.plan.slug) : '';
    const body = `
      <p class="muted">Choosing a paid plan creates a pending upgrade request. Your current plan stays active until an administrator verifies the subscription payment through manual billing. Choosing Free takes effect immediately.</p>
      <div class="grid">${plans.map((p) => `<div class="card"><h3>${escapeHtml(p.name)}</h3><p class="big">${escapeHtml(planPriceText(p))}</p><p>${escapeHtml(p.description || '')}</p><p class="muted">Transactions / month: ${p.transaction_limit === null || p.transaction_limit === undefined ? 'Unlimited' : escapeHtml(String(p.transaction_limit))} · API / month: ${p.api_limit === null || p.api_limit === undefined ? 'Unlimited' : escapeHtml(String(p.api_limit))}</p>${p.slug === currentSlug ? '<p><strong>Current plan</strong></p>' : `<form method="post" action="/merchant/subscription/change">${csrfField(req.csrf)}<input type="hidden" name="plan_id" value="${escapeHtml(p.id || '')}"><input type="hidden" name="plan_slug" value="${escapeHtml(p.slug)}"><label>Billing cycle<select name="billing_cycle"><option value="monthly">Monthly</option><option value="annual">Annual</option></select></label><p><button class="btn" type="submit">Choose ${escapeHtml(p.name)}</button></p></form>`}</div>`).join('')}</div>
    `;
    res.send(layout({ title: 'Change plan', body, user: { label: req.merchant.business_name, logout: '/merchant/logout' }, nav: merchantNav() }));
  });

  app.post('/merchant/subscription/change', requireMerchant, requireCsrf, async (req, res) => {
    const pool = poolOrNull(req, res); if (!pool || res.headersSent) return;
    let plan = null;
    if (req.body.plan_id) plan = await getPlanById(pool, req.body.plan_id).catch(() => null);
    if (!plan && req.body.plan_slug) plan = await getPlanBySlug(pool, req.body.plan_slug).catch(() => null);
    if (!plan || !plan.is_active) {
      return res.status(400).send(layout({ title: 'Change plan', body: `<div class="alert error">That plan is not available. Please choose an active plan.</div><p><a href="/merchant/subscription/change">Back</a></p>`, user: { label: req.merchant.business_name, logout: '/merchant/logout' }, nav: merchantNav() }));
    }
    const cycle = req.body.billing_cycle === 'annual' ? 'annual' : 'monthly';
    const current = await getCurrentSubscription(pool, req.merchant.id);
    if (current.plan && (current.plan.plan_slug || current.plan.slug) === plan.slug && current.subscription) {
      return res.status(400).send(layout({ title: 'Change plan', body: `<div class="alert error">You are already on this plan.</div><p><a href="/merchant/subscription">Back to subscription</a></p>`, user: { label: req.merchant.business_name, logout: '/merchant/logout' }, nav: merchantNav() }));
    }
    const price = cycle === 'annual' ? Number(plan.price_annual_paise || 0) : Number(plan.price_monthly_paise || 0);
    // Free: immediate. Paid: pending_payment, previous plan stays
    // active until an admin verifies the subscription payment.
    const sub = await createSubscription(pool, { merchantId: req.merchant.id, plan, billingCycle: cycle, status: price === 0 ? 'active' : 'pending_payment', paymentStatus: price === 0 ? 'not_required' : 'pending_manual' }).catch(() => null);
    if (!sub) {
      return res.status(503).send(layout({ title: 'Change plan', body: `<div class="alert error">Subscriptions are not available yet on this database. Ask an administrator to run pending migrations from Admin &gt; Settings.</div>`, user: { label: req.merchant.business_name, logout: '/merchant/logout' }, nav: merchantNav() }));
    }
    if (price === 0 && current.subscription) {
      await pool.query("UPDATE merchant_subscriptions SET status = 'cancelled', cancelled_at = UTC_TIMESTAMP() WHERE merchant_id = ? AND status = 'active' AND id != ?", [req.merchant.id, sub.id]).catch(() => {});
    }
    await audit(pool, { actorType: 'merchant', actorId: req.merchant.id, merchantId: req.merchant.id, entityType: 'subscription', entityId: sub.id, action: price === 0 ? 'subscription_changed_free' : 'subscription_upgrade_requested', details: { plan_slug: plan.slug, billing_cycle: cycle }, ip: req.ip });
    const msg = price === 0
      ? 'Your plan has been changed to Free with immediate effect.'
      : 'Your upgrade request has been recorded and is pending payment verification. Your current plan stays active until an administrator verifies the subscription payment through manual billing. Contact support if you have already paid.';
    res.send(layout({ title: 'Change plan', body: `<div class="alert success">${escapeHtml(msg)}</div><p><a class="btn" href="/merchant/subscription">View subscription</a></p>`, user: { label: req.merchant.business_name, logout: '/merchant/logout' }, nav: merchantNav() }));
  });

  app.get('/merchant/security', requireMerchant, async (req, res) => {
    const pool = poolOrNull(req, res); if (!pool || res.headersSent) return;
    const verified = await isEmailVerified(pool, req.merchant.id).catch(() => false);
    const body = `
      <h2>Change password</h2>
      <form method="post" action="/merchant/security/password">${csrfField(req.csrf)}${field('Current password', 'current_password', 'password', '', 'required')}${field('New password (at least 10 characters)', 'new_password', 'password', '', 'required')}${field('Confirm new password', 'new_password_confirm', 'password', '', 'required')}<p><button class="btn" type="submit">Change password</button></p></form>
      <p class="muted">Changing your password signs you out of your other sessions. Your current session stays signed in.</p>
      <h2>Email verification</h2>
      <p>Email verified: <strong>${verified ? 'Yes' : 'No'}</strong></p>
      ${verified ? '' : `<form method="post" action="/merchant/security/verify-email">${csrfField(req.csrf)}<p><button class="btn secondary" type="submit">Send verification link</button></p></form><p class="muted">If no email service is configured for this installation, the link cannot be sent by email. In that case, ask an administrator to mark your email verified after confirming your identity through support.</p>`}
      <p class="muted">Email delivery is configured: <strong>${mailerConfigured() ? 'Yes' : 'No — SMTP is not set in the environment, so verification and reset emails cannot be sent yet.'}</strong></p>
    `;
    res.send(layout({ title: 'Security', body, user: { label: req.merchant.business_name, logout: '/merchant/logout' }, nav: merchantNav() }));
  });

  app.post('/merchant/security/password', requireMerchant, requireCsrf, async (req, res) => {
    const pool = poolOrNull(req, res); if (!pool || res.headersSent) return;
    const current = String(req.body.current_password || '');
    const next = String(req.body.new_password || '');
    const confirm = String(req.body.new_password_confirm || '');
    if (!current || next.length < 10 || next !== confirm) {
      return res.status(400).send(layout({ title: 'Security', body: `<div class="alert error">Check your current password, and make the new password at least 10 characters, matching its confirmation.</div><p><a href="/merchant/security">Back</a></p>`, user: { label: req.merchant.business_name, logout: '/merchant/logout' }, nav: merchantNav() }));
    }
    let ok = false;
    try { ok = await verifyPassword(current, req.merchant.password_hash); } catch { ok = false; }
    if (!ok) {
      return res.status(403).send(layout({ title: 'Security', body: `<div class="alert error">Current password is incorrect.</div><p><a href="/merchant/security">Back</a></p>`, user: { label: req.merchant.business_name, logout: '/merchant/logout' }, nav: merchantNav() }));
    }
    const hash = await hashPassword(next);
    await pool.query('UPDATE merchants SET password_hash = ? WHERE id = ?', [hash, req.merchant.id]);
    try { await pool.query('DELETE FROM sessions WHERE actor_type = ? AND actor_id = ? AND token_hash != ?', ['merchant', req.merchant.id, sha256Hex(req.merchantToken)]); } catch {}
    await audit(pool, { actorType: 'merchant', actorId: req.merchant.id, merchantId: req.merchant.id, entityType: 'merchant', entityId: req.merchant.slug, action: 'merchant_password_changed', details: {}, ip: req.ip });
    res.send(layout({ title: 'Security', body: `<div class="alert success">Password changed. Your other sessions have been signed out.</div><p><a class="btn secondary" href="/merchant/dashboard">Back to dashboard</a></p>`, user: { label: req.merchant.business_name, logout: '/merchant/logout' }, nav: merchantNav() }));
  });

  app.post('/merchant/security/verify-email', requireMerchant, requireCsrf, async (req, res) => {
    const pool = poolOrNull(req, res); if (!pool || res.headersSent) return;
    const created = await createEmailVerification(pool, req.merchant.id).catch(() => null);
    if (!created) {
      return res.status(503).send(layout({ title: 'Security', body: `<div class="alert error">Email verification is not available yet on this database. Ask an administrator to run pending migrations.</div>`, user: { label: req.merchant.business_name, logout: '/merchant/logout' }, nav: merchantNav() }));
    }
    if (!mailerConfigured()) {
      return res.send(layout({ title: 'Security', body: `<div class="alert info">A verification token was created, but no email service is configured for this installation, so no email was sent. Ask an administrator to mark your email verified after confirming your identity through support.</div>`, user: { label: req.merchant.business_name, logout: '/merchant/logout' }, nav: merchantNav() }));
    }
    try {
      const base = config.baseUrl || '';
      await sendMail({ to: req.merchant.contact_email, subject: 'Verify your YOUPI PG email', text: `Verify your email by opening this link (valid for 24 hours): ${base}/merchant/verify-email?token=${created.token}` });
      res.send(layout({ title: 'Security', body: `<div class="alert success">Verification link sent to your email address.</div>`, user: { label: req.merchant.business_name, logout: '/merchant/logout' }, nav: merchantNav() }));
    } catch {
      res.status(503).send(layout({ title: 'Security', body: `<div class="alert error">The verification email could not be sent. Please try again later or contact support.</div>`, user: { label: req.merchant.business_name, logout: '/merchant/logout' }, nav: merchantNav() }));
    }
  });

  app.get('/merchant/verify-email', async (req, res) => {
    const pool = poolOrNull(req, res); if (!pool || res.headersSent) return;
    const found = await findValidEmailVerification(pool, String(req.query.token || '')).catch(() => null);
    if (!found) {
      return res.status(400).send(layout({ title: 'Email verification', body: `<div class="alert error">This verification link is invalid, expired, or already used.</div><p><a href="/merchant/login">Merchant login</a></p>` }));
    }
    await pool.query('UPDATE email_verifications SET verified_at = UTC_TIMESTAMP() WHERE id = ?', [found.id]);
    await audit(pool, { actorType: 'merchant', actorId: found.merchant_id, merchantId: found.merchant_id, entityType: 'merchant', entityId: found.merchant_id, action: 'merchant_email_verified', details: {}, ip: req.ip });
    res.send(layout({ title: 'Email verification', body: `<div class="alert success">Your email address is now verified.</div><p><a class="btn" href="/merchant/login">Merchant login</a></p>` }));
  });

  app.get('/merchant/activity', requireMerchant, async (req, res) => {
    const pool = poolOrNull(req, res); if (!pool || res.headersSent) return;
    const { page, perPage, offset } = pagination(req.query);
    const [rows] = await pool.query('SELECT * FROM audit_logs WHERE merchant_id = ? ORDER BY created_at DESC LIMIT ? OFFSET ?', [req.merchant.id, perPage + 1, offset]);
    const hasMore = rows.length > perPage;
    const shown = hasMore ? rows.slice(0, perPage) : rows;
    const body = `
      <p class="muted">Activity for your account only: logins, profile changes, API key actions, order creation, subscription changes and password changes, with IP address and time where recorded.</p>
      ${shown.length ? `<table><thead><tr><th>When</th><th>Action</th><th>Entity</th><th>IP</th></tr></thead><tbody>${shown.map((r) => `<tr><td>${formatDate(r.created_at)}</td><td>${escapeHtml(r.action)}</td><td>${escapeHtml(r.entity_type)}: ${escapeHtml(r.entity_id)}</td><td>${escapeHtml(r.ip_address || '—')}</td></tr>`).join('')}</tbody></table>${paginationLinks(`/merchant/activity?`, page, perPage, hasMore)}` : '<p class="muted">No activity yet.</p>'}
    `;
    res.send(layout({ title: 'Account activity', body, user: { label: req.merchant.business_name, logout: '/merchant/logout' }, nav: merchantNav() }));
  });

  // Password reset (merchant and admin, same token rules). Requests
  // never reveal whether an account exists, and a token is never
  // shown in a page or a response.
  app.get('/merchant/forgot-password', async (req, res) => {
    res.send(layout({ title: 'Forgot password', body: `<form method="post" action="/merchant/forgot-password">${field('Merchant email', 'email', 'email', '', 'required')}<p><button class="btn" type="submit">Request reset link</button></p></form><p class="muted">If an account exists for that email, a reset link will be sent when an email service is configured. The link is valid for 1 hour and can be used once.</p>` }));
  });

  app.post('/merchant/forgot-password', loginLimiter, async (req, res) => {
    const pool = poolOrNull(req, res); if (!pool || res.headersSent) return;
    const email = cleanString(req.body.email || '', 255);
    const generic = `<div class="alert success">If an account exists for that email, a password reset link has been requested. Check your email (when an email service is configured for this installation).</div><p><a href="/merchant/login">Merchant login</a></p>`;
    if (!isEmail(email)) {
      return res.send(layout({ title: 'Forgot password', body: generic }));
    }
    try {
      const [rows] = await pool.query('SELECT id, contact_email FROM merchants WHERE contact_email = ?', [email]);
      if (rows[0]) {
        const created = await createPasswordReset(pool, 'merchant', rows[0].id);
        if (mailerConfigured()) {
          try {
            const base = config.baseUrl || '';
            await sendMail({ to: rows[0].contact_email, subject: 'Reset your YOUPI PG password', text: `Reset your password with this link (valid for 1 hour, single use): ${base}/merchant/reset-password?token=${created.token}` });
          } catch { /* generic message still applies; do not leak the failure reason */ }
        }
      }
    } catch { /* generic message still applies */ }
    res.send(layout({ title: 'Forgot password', body: generic }));
  });

  app.get('/merchant/reset-password', async (req, res) => {
    res.send(layout({ title: 'Reset password', body: `<form method="post" action="/merchant/reset-password"><input type="hidden" name="token" value="${escapeHtml(String(req.query.token || ''))}">${field('New password (at least 10 characters)', 'new_password', 'password', '', 'required')}${field('Confirm new password', 'new_password_confirm', 'password', '', 'required')}<p><button class="btn" type="submit">Reset password</button></p></form>` }));
  });

  app.post('/merchant/reset-password', loginLimiter, async (req, res) => {
    const pool = poolOrNull(req, res); if (!pool || res.headersSent) return;
    const token = String(req.body.token || '');
    const next = String(req.body.new_password || '');
    const confirm = String(req.body.new_password_confirm || '');
    const found = await findValidPasswordReset(pool, token).catch(() => null);
    if (!found || found.user_type !== 'merchant' || next.length < 10 || next !== confirm) {
      return res.status(400).send(layout({ title: 'Reset password', body: `<div class="alert error">This reset link is invalid, expired, or already used, or the new password does not meet the requirements.</div><p><a href="/merchant/forgot-password">Request a new link</a></p>` }));
    }
    const hash = await hashPassword(next);
    await pool.query('UPDATE merchants SET password_hash = ? WHERE id = ?', [hash, found.user_id]);
    await markPasswordResetUsed(pool, found.id);
    try { await pool.query('DELETE FROM sessions WHERE actor_type = ? AND actor_id = ?', ['merchant', found.user_id]); } catch {}
    await audit(pool, { actorType: 'merchant', actorId: found.user_id, merchantId: found.user_id, entityType: 'merchant', entityId: found.user_id, action: 'merchant_password_reset', details: {}, ip: req.ip });
    res.send(layout({ title: 'Reset password', body: `<div class="alert success">Password reset. You can now log in with your new password.</div><p><a class="btn" href="/merchant/login">Merchant login</a></p>` }));
  });

  app.get('/admin/forgot-password', async (req, res) => {
    res.send(layout({ title: 'Admin forgot password', body: `<form method="post" action="/admin/forgot-password">${field('Admin email', 'email', 'email', '', 'required')}<p><button class="btn" type="submit">Request reset link</button></p></form><p class="muted">If an account exists for that email, a reset link will be sent when an email service is configured. The link is valid for 1 hour and can be used once.</p>` }));
  });

  app.post('/admin/forgot-password', loginLimiter, async (req, res) => {
    const pool = poolOrNull(req, res); if (!pool || res.headersSent) return;
    const email = cleanString(req.body.email || '', 255);
    const generic = `<div class="alert success">If an account exists for that email, a password reset link has been requested.</div><p><a href="/admin/login">Admin login</a></p>`;
    if (!isEmail(email)) return res.send(layout({ title: 'Admin forgot password', body: generic }));
    try {
      const [rows] = await pool.query('SELECT id, email FROM admins WHERE email = ?', [email]);
      if (rows[0]) {
        const created = await createPasswordReset(pool, 'admin', rows[0].id);
        if (mailerConfigured()) {
          try {
            const base = config.baseUrl || '';
            await sendMail({ to: rows[0].email, subject: 'Reset your YOUPI PG admin password', text: `Reset your password with this link (valid for 1 hour, single use): ${base}/admin/reset-password?token=${created.token}` });
          } catch {}
        }
      }
    } catch {}
    res.send(layout({ title: 'Admin forgot password', body: generic }));
  });

  app.get('/admin/reset-password', async (req, res) => {
    res.send(layout({ title: 'Admin reset password', body: `<form method="post" action="/admin/reset-password"><input type="hidden" name="token" value="${escapeHtml(String(req.query.token || ''))}">${field('New password (at least 10 characters)', 'new_password', 'password', '', 'required')}${field('Confirm new password', 'new_password_confirm', 'password', '', 'required')}<p><button class="btn" type="submit">Reset password</button></p></form>` }));
  });

  app.post('/admin/reset-password', loginLimiter, async (req, res) => {
    const pool = poolOrNull(req, res); if (!pool || res.headersSent) return;
    const token = String(req.body.token || '');
    const next = String(req.body.new_password || '');
    const confirm = String(req.body.new_password_confirm || '');
    const found = await findValidPasswordReset(pool, token).catch(() => null);
    if (!found || found.user_type !== 'admin' || next.length < 10 || next !== confirm) {
      return res.status(400).send(layout({ title: 'Admin reset password', body: `<div class="alert error">This reset link is invalid, expired, or already used, or the new password does not meet the requirements.</div><p><a href="/admin/forgot-password">Request a new link</a></p>` }));
    }
    const hash = await hashPassword(next);
    await pool.query('UPDATE admins SET password_hash = ? WHERE id = ?', [hash, found.user_id]);
    await markPasswordResetUsed(pool, found.id);
    try { await pool.query('DELETE FROM sessions WHERE actor_type = ? AND actor_id = ?', ['admin', found.user_id]); } catch {}
    await audit(pool, { actorType: 'admin', actorId: found.user_id, merchantId: null, entityType: 'admin', entityId: found.user_id, action: 'admin_password_reset', details: {}, ip: req.ip });
    res.send(layout({ title: 'Admin reset password', body: `<div class="alert success">Password reset. You can now log in with your new password.</div><p><a class="btn" href="/admin/login">Admin login</a></p>` }));
  });

  // ---------- Admin ----------
  app.get('/admin/login', (req, res) => {
    res.send(layout({ title: 'Admin login', body: `<form method="post" action="/admin/login">${field('Email', 'email', 'email', '', 'required')}${field('Password', 'password', 'password', '', 'required')}<p><button class="btn" type="submit">Log in</button></p></form><p><a href="/admin/forgot-password">Forgot password?</a></p>` }));
  });

  app.post('/admin/login', loginLimiter, async (req, res) => {
    const pool = poolOrNull(req, res); if (!pool || res.headersSent) return;
    const [rows] = await pool.query('SELECT * FROM admins WHERE email = ?', [cleanString(req.body.email, 255)]);
    const admin = rows[0];
    if (!admin || admin.status !== 'active' || !verifyPassword(req.body.password || '', admin.password_hash)) {
      return res.status(401).send(layout({ title: 'Admin login', body: alert('error', 'Invalid email or password.') + '<p><a href="/admin/login">Try again</a></p>' }));
    }
    await pool.query('UPDATE admins SET last_login_at = UTC_TIMESTAMP() WHERE id = ?', [admin.id]);
    const session = await createSession(pool, 'admin', admin.id, req.ip, req.headers['user-agent']);
    res.cookie('gw_session', session.token, sessionCookieOptions(config));
    await audit(pool, { actorType: 'admin', actorId: admin.id, merchantId: null, entityType: 'admin', entityId: admin.email, action: 'admin_login', details: {}, ip: req.ip });
    res.redirect('/admin/dashboard');
  });

  app.get('/admin/logout', async (req, res) => {
    const pool = poolOverride || (config.db.configured ? getPool(config) : null);
    const token = req.headers.cookie?.split(';').map((c) => c.trim()).find((c) => c.startsWith('gw_session='))?.slice('gw_session='.length);
    if (pool && token) await deleteSession(pool, decodeURIComponent(token));
    res.clearCookie('gw_session', { path: '/' });
    res.redirect('/');
  });

  async function requireAdmin(req, res, next) {
    const auth = await adminFromCookie(req);
    if (!auth) return res.redirect('/admin/login');
    req.admin = auth.admin;
    req.adminSession = auth.session;
    req.adminToken = auth.token;
    req.csrf = csrfTokenFor(auth.token, config.sessionSecret);
    return next();
  }

  app.get('/admin/dashboard', requireAdmin, async (req, res) => {
    const pool = poolOrNull(req, res); if (!pool || res.headersSent) return;
    const [mStats] = await pool.query("SELECT status, COUNT(*) AS n FROM merchants GROUP BY status");
    const [oStats] = await pool.query("SELECT status, COUNT(*) AS n, COALESCE(SUM(amount_paise), 0) AS total FROM orders GROUP BY status");
    const [pendingMerchants] = await pool.query("SELECT * FROM merchants WHERE status = 'pending' ORDER BY created_at ASC LIMIT 10");
    const [queue] = await pool.query("SELECT COUNT(*) AS n FROM orders WHERE status = 'processing'");
    const [recentOrders] = await pool.query('SELECT o.*, m.business_name FROM orders o JOIN merchants m ON m.id = o.merchant_id ORDER BY o.created_at DESC LIMIT 10');
    const mBy = {}; for (const r of mStats) mBy[r.status] = Number(r.n);
    const oBy = {}; let oTotal = 0; let successTotal = 0; for (const r of oStats) { oBy[r.status] = Number(r.n); oTotal += Number(r.n); if (r.status === 'success') successTotal = Number(r.total); }
    const body = `
      <div class="grid">
        <div class="card"><h3>Merchants</h3><p class="big">${Object.values(mBy).reduce((a, b) => a + b, 0)}</p><p>Pending: ${mBy.pending || 0} · Approved: ${mBy.approved || 0} · Suspended: ${mBy.suspended || 0}</p></div>
        <div class="card"><h3>Orders</h3><p class="big">${oTotal}</p><p>Successful revenue: ${formatPaise(successTotal)}</p></div>
        <div class="card"><h3>Verification queue</h3><p class="big">${queue[0]?.n || 0}</p><p>Orders in processing awaiting verification.</p></div>
      </div>
      <h2>Pending merchants</h2>
      ${pendingMerchants.length ? `<table><thead><tr><th>Business</th><th>Email</th><th>UPI</th><th>Created</th></tr></thead><tbody>${pendingMerchants.map((m) => `<tr><td><a href="/admin/merchants/${escapeHtml(m.id)}">${escapeHtml(m.business_name)}</a></td><td>${escapeHtml(m.contact_email)}</td><td>${escapeHtml(m.upi_id || '—')}</td><td>${formatDate(m.created_at)}</td></tr>`).join('')}</tbody></table>` : '<p class="muted">No pending merchants.</p>'}
      <h2>Recent orders</h2>
      ${recentOrders.length ? `<table><thead><tr><th>Reference</th><th>Merchant</th><th>Amount</th><th>Status</th><th>Verified by</th><th>Created</th></tr></thead><tbody>${recentOrders.map((o) => `<tr><td><a href="/admin/orders/${escapeHtml(o.gateway_reference)}">${escapeHtml(o.gateway_reference)}</a></td><td>${escapeHtml(o.business_name)}</td><td>${formatPaise(o.amount_paise)}</td><td>${statusBadge(o.status)}</td><td>${escapeHtml(o.verification_source || 'none')}</td><td>${formatDate(o.created_at)}</td></tr>`).join('')}</tbody></table>` : '<p class="muted">No orders yet.</p>'}
    `;
    res.send(layout({ title: 'Admin dashboard', body, user: { label: req.admin.email, logout: '/admin/logout' }, nav: adminNav() }));
  });

  app.get('/admin/merchants', requireAdmin, async (req, res) => {
    const pool = poolOrNull(req, res); if (!pool || res.headersSent) return;
    const { page, perPage, offset } = pagination(req.query);
    const q = cleanString(req.query.q || '', 100);
    const status = cleanString(req.query.status || '', 20);
    const where = ['1=1']; const params = [];
    if (q) { where.push('(business_name LIKE ? OR contact_email LIKE ? OR slug LIKE ?)'); params.push(`%${q}%`, `%${q}%`, `%${q}%`); }
    if (status) { where.push('status = ?'); params.push(status); }
    const [rows] = await pool.query(`SELECT * FROM merchants WHERE ${where.join(' AND ')} ORDER BY created_at DESC LIMIT ? OFFSET ?`, [...params, perPage + 1, offset]);
    const hasMore = rows.length > perPage; const shown = hasMore ? rows.slice(0, perPage) : rows;
    const base = `/admin/merchants?q=${encodeURIComponent(q)}&status=${encodeURIComponent(status)}`;
    const body = `
      <form method="get" action="/admin/merchants" class="inline-form"><input name="q" value="${escapeHtml(q)}" placeholder="Search business, email or slug"><select name="status"><option value="">All</option>${['pending', 'approved', 'suspended'].map((s) => `<option value="${s}" ${status === s ? 'selected' : ''}>${s}</option>`).join('')}</select><button type="submit">Filter</button></form>
      ${shown.length ? `<table><thead><tr><th>Business</th><th>Slug</th><th>Email</th><th>UPI</th><th>Status</th><th>Created</th></tr></thead><tbody>${shown.map((m) => `<tr><td><a href="/admin/merchants/${escapeHtml(m.id)}">${escapeHtml(m.business_name)}</a></td><td>${escapeHtml(m.slug)}</td><td>${escapeHtml(m.contact_email)}</td><td>${escapeHtml(m.upi_id || '—')}</td><td>${statusBadge(m.status)}</td><td>${formatDate(m.created_at)}</td></tr>`).join('')}</tbody></table>${paginationLinks(base, page, perPage, hasMore)}` : '<p class="muted">No merchants found.</p>'}
    `;
    res.send(layout({ title: 'Merchants', body, user: { label: req.admin.email, logout: '/admin/logout' }, nav: adminNav() }));
  });

  app.get('/admin/merchants/:id', requireAdmin, async (req, res) => {
    const pool = poolOrNull(req, res); if (!pool || res.headersSent) return;
    const [rows] = await pool.query('SELECT * FROM merchants WHERE id = ?', [req.params.id]);
    const m = rows[0];
    if (!m) return res.status(404).send(layout({ title: 'Merchant not found', body: '<p>Merchant not found.</p>' }));
    const [orders] = await pool.query('SELECT * FROM orders WHERE merchant_id = ? ORDER BY created_at DESC LIMIT 20', [m.id]);
    const [keys] = await pool.query('SELECT key_prefix, key_type, name, status, created_at FROM merchant_api_keys WHERE merchant_id = ? ORDER BY created_at DESC', [m.id]);
    const body = `
      <p><strong>Business:</strong> ${escapeHtml(m.business_name)} &nbsp; <strong>Slug:</strong> ${escapeHtml(m.slug)} &nbsp; <strong>Status:</strong> ${statusBadge(m.status)}</p>
      <p><strong>Email:</strong> ${escapeHtml(m.contact_email)} &nbsp; <strong>Phone:</strong> ${escapeHtml(m.contact_phone || '—')} &nbsp; <strong>UPI:</strong> ${escapeHtml(m.upi_id || '—')} (${escapeHtml(m.payee_name || '—')})</p>
      <p><strong>Webhook:</strong> ${escapeHtml(m.webhook_url || 'not set')} &nbsp; <strong>Suspension reason:</strong> ${escapeHtml(m.suspension_reason || '—')}</p>
      <form method="post" action="/admin/merchants/${escapeHtml(m.id)}/approve" style="display:inline">${csrfField(req.csrf)}<button class="btn" type="submit">Approve</button></form>
      <form method="post" action="/admin/merchants/${escapeHtml(m.id)}/suspend" style="display:inline">${csrfField(req.csrf)}<input name="reason" placeholder="Reason (required for suspension/rejection)" style="width:280px"><button type="submit">Suspend / Reject</button></form>
      <form method="post" action="/admin/merchants/${escapeHtml(m.id)}/reactivate" style="display:inline">${csrfField(req.csrf)}<button class="btn secondary" type="submit">Reactivate</button></form>
      <form method="post" action="/admin/merchants/${escapeHtml(m.id)}/verify-email" style="display:inline">${csrfField(req.csrf)}<button class="btn secondary" type="submit">Mark email verified (admin-confirmed)</button></form>
      <p class="muted">Mark email verified only after confirming the merchant's identity through support or another trusted channel. This is the fallback when no email service is configured to send a verification link.</p>
      <h2>Recent orders</h2>${ordersTable(orders, { detailBase: '/admin/orders' })}
      <h2>API keys</h2>${keys.length ? `<table><thead><tr><th>Prefix</th><th>Type</th><th>Name</th><th>Status</th><th>Created</th></tr></thead><tbody>${keys.map((k) => `<tr><td><code>${escapeHtml(k.key_prefix)}</code></td><td>${escapeHtml(k.key_type)}</td><td>${escapeHtml(k.name || '—')}</td><td>${escapeHtml(k.status)}</td><td>${formatDate(k.created_at)}</td></tr>`).join('')}</tbody></table>` : '<p class="muted">No API keys.</p>'}
    `;
    res.send(layout({ title: `Merchant — ${m.business_name}`, body, user: { label: req.admin.email, logout: '/admin/logout' }, nav: adminNav() }));
  });

  async function adminMerchantAction(req, res, action) {
    const pool = poolOrNull(req, res); if (!pool || res.headersSent) return;
    const [rows] = await pool.query('SELECT * FROM merchants WHERE id = ?', [req.params.id]);
    const m = rows[0];
    if (!m) return res.status(404).send('Merchant not found.');
    const reason = cleanString(req.body.reason || '', 500);
    if (action === 'approve') {
      await pool.query("UPDATE merchants SET status = 'approved', approved_at = UTC_TIMESTAMP(), suspended_at = NULL, suspension_reason = NULL WHERE id = ?", [m.id]);
    } else if (action === 'suspend') {
      if (!reason) return res.status(400).send(layout({ title: 'Merchant action', body: alert('error', 'A reason is required for suspension or rejection.') + `<p><a href="/admin/merchants/${escapeHtml(m.id)}">Back</a></p>` }));
      await pool.query("UPDATE merchants SET status = 'suspended', suspended_at = UTC_TIMESTAMP(), suspension_reason = ? WHERE id = ?", [reason, m.id]);
    } else if (action === 'reactivate') {
      await pool.query("UPDATE merchants SET status = 'approved', approved_at = UTC_TIMESTAMP(), suspended_at = NULL, suspension_reason = NULL WHERE id = ?", [m.id]);
    }
    await audit(pool, { actorType: 'admin', actorId: req.admin.id, merchantId: m.id, entityType: 'merchant', entityId: m.slug, action: `merchant_${action}`, details: { reason }, ip: req.ip });
    res.redirect(`/admin/merchants/${m.id}`);
  }
  app.post('/admin/merchants/:id/verify-email', requireAdmin, requireCsrf, async (req, res) => {
    const pool = poolOrNull(req, res); if (!pool || res.headersSent) return;
    const [rows] = await pool.query('SELECT id FROM merchants WHERE id = ?', [req.params.id]);
    if (!rows[0]) return res.status(404).send('Merchant not found.');
    try {
      await pool.query('INSERT INTO email_verifications (id, merchant_id, token_hash, expires_at, verified_at) VALUES (?, ?, ?, UTC_TIMESTAMP(), UTC_TIMESTAMP())', [randomUUID(), req.params.id, sha256Hex(`admin-verified-${req.params.id}-${Date.now()}`)]);
    } catch {
      return res.status(503).send(layout({ title: 'Merchant', body: `<div class="alert error">Email verification is not available yet on this database. Run pending migrations first.</div>`, user: { label: req.admin.email, logout: '/admin/logout' }, nav: adminNav() }));
    }
    await audit(pool, { actorType: 'admin', actorId: req.admin.id, merchantId: req.params.id, entityType: 'merchant', entityId: req.params.id, action: 'merchant_email_verified_by_admin', details: {}, ip: req.ip });
    res.redirect(`/admin/merchants/${escapeHtml(req.params.id)}`);
  });

  app.post('/admin/merchants/:id/approve', requireAdmin, requireCsrf, (req, res) => adminMerchantAction(req, res, 'approve'));
  app.post('/admin/merchants/:id/suspend', requireAdmin, requireCsrf, (req, res) => adminMerchantAction(req, res, 'suspend'));
  app.post('/admin/merchants/:id/reactivate', requireAdmin, requireCsrf, (req, res) => adminMerchantAction(req, res, 'reactivate'));

  app.get('/admin/orders', requireAdmin, async (req, res) => {
    const pool = poolOrNull(req, res); if (!pool || res.headersSent) return;
    const { page, perPage, offset } = pagination(req.query);
    const q = cleanString(req.query.q || '', 100);
    const status = cleanString(req.query.status || '', 20);
    const where = ['1=1']; const params = [];
    if (q) { where.push('(o.gateway_reference LIKE ? OR o.merchant_order_id LIKE ? OR o.verification_utr LIKE ? OR m.business_name LIKE ?)'); params.push(`%${q}%`, `%${q}%`, `%${q}%`, `%${q}%`); }
    if (status) { where.push('o.status = ?'); params.push(status); }
    const [orders] = await pool.query(`SELECT o.*, m.business_name FROM orders o JOIN merchants m ON m.id = o.merchant_id WHERE ${where.join(' AND ')} ORDER BY o.created_at DESC LIMIT ? OFFSET ?`, [...params, perPage + 1, offset]);
    const hasMore = orders.length > perPage; const shown = hasMore ? orders.slice(0, perPage) : orders;
    const base = `/admin/orders?q=${encodeURIComponent(q)}&status=${encodeURIComponent(status)}`;
    const body = `
      <form method="get" action="/admin/orders" class="inline-form"><input name="q" value="${escapeHtml(q)}" placeholder="Search reference, order ID, UTR or merchant"><select name="status"><option value="">All statuses</option>${['pending', 'processing', 'success', 'failed', 'expired', 'cancelled', 'refunded'].map((s) => `<option value="${s}" ${status === s ? 'selected' : ''}>${s}</option>`).join('')}</select><button type="submit">Filter</button></form>
      ${shown.length ? `<table><thead><tr><th>Reference</th><th>Merchant</th><th>Order</th><th>Amount</th><th>Status</th><th>Verified by</th><th>Created</th></tr></thead><tbody>${shown.map((o) => `<tr><td><a href="/admin/orders/${escapeHtml(o.gateway_reference)}">${escapeHtml(o.gateway_reference)}</a></td><td>${escapeHtml(o.business_name)}</td><td>${escapeHtml(o.merchant_order_id)}</td><td>${formatPaise(o.amount_paise)}</td><td>${statusBadge(o.status)}</td><td>${escapeHtml(o.verification_source || 'none')}</td><td>${formatDate(o.created_at)}</td></tr>`).join('')}</tbody></table>${paginationLinks(base, page, perPage, hasMore)}` : '<p class="muted">No orders found.</p>'}
    `;
    res.send(layout({ title: 'Orders', body, user: { label: req.admin.email, logout: '/admin/logout' }, nav: adminNav() }));
  });

  app.get('/admin/orders/:ref', requireAdmin, async (req, res) => {
    const pool = poolOrNull(req, res); if (!pool || res.headersSent) return;
    const [rows] = await pool.query('SELECT o.*, m.business_name, m.contact_email FROM orders o JOIN merchants m ON m.id = o.merchant_id WHERE o.gateway_reference = ?', [req.params.ref]);
    const order = rows[0];
    if (!order) return res.status(404).send(layout({ title: 'Order not found', body: '<p>Order not found.</p>' }));
    const [events] = await pool.query('SELECT * FROM order_events WHERE order_id = ? ORDER BY created_at ASC', [order.id]);
    const [deliveries] = await pool.query('SELECT * FROM webhook_deliveries WHERE order_id = ? ORDER BY created_at DESC', [order.id]);
    const body = `
      <p><strong>Merchant:</strong> ${escapeHtml(order.business_name)} (${escapeHtml(order.contact_email)}) &nbsp; <strong>Merchant order:</strong> ${escapeHtml(order.merchant_order_id)} &nbsp; <strong>Mode:</strong> ${escapeHtml(order.mode || 'live')}</p>
      <p><strong>Amount:</strong> ${formatPaise(order.amount_paise)} &nbsp; <strong>Status:</strong> ${statusBadge(order.status)} &nbsp; <strong>Verified by:</strong> ${escapeHtml(order.verification_source || 'none')} &nbsp; <strong>UTR:</strong> ${escapeHtml(order.verification_utr || '—')}</p>
      <p><strong>Checkout:</strong> <a href="/checkout/${escapeHtml(order.gateway_reference)}">/checkout/${escapeHtml(order.gateway_reference)}</a></p>
      ${order.status === 'success' ? `<h2>Record a refund</h2><p class="muted">This records a refund in the gateway and sends a REFUNDED webhook to the merchant. It does not automatically move money back at the bank — record the actual bank refund separately, then record it here.</p><form method="post" action="/admin/orders/${escapeHtml(order.gateway_reference)}/refund">${csrfField(req.csrf)}${field('Refund reason (optional)', 'refund_reason', 'text', '')}<p><button class="btn" type="submit">Record refund</button></p></form>` : ''}
      <h2>Events</h2>${events.length ? `<table><thead><tr><th>Event</th><th>From</th><th>To</th><th>Source</th><th>When</th></tr></thead><tbody>${events.map((e) => `<tr><td>${escapeHtml(e.event_type)}</td><td>${escapeHtml(e.status_from || '—')}</td><td>${escapeHtml(e.status_to || '—')}</td><td>${escapeHtml(e.source || '—')}</td><td>${formatDate(e.created_at)}</td></tr>`).join('')}</tbody></table>` : '<p class="muted">No events yet.</p>'}
      <h2>Webhook deliveries</h2>${deliveries.length ? `<table><thead><tr><th>Event</th><th>Endpoint</th><th>Status</th><th>Attempts</th><th>When</th></tr></thead><tbody>${deliveries.map((d) => `<tr><td>${escapeHtml(d.event_type)}</td><td>${escapeHtml(d.endpoint_url)}</td><td>${d.is_successful ? 'delivered' : 'pending/failed'} (${d.response_status || '—'})</td><td>${d.attempt_count}</td><td>${formatDate(d.created_at)}</td></tr>`).join('')}</tbody></table>` : '<p class="muted">No webhook deliveries for this order.</p>'}
      <p><a class="btn secondary" href="/admin/verify">Verification queue</a></p>
    `;
    res.send(layout({ title: `Order ${order.gateway_reference}`, body, user: { label: req.admin.email, logout: '/admin/logout' }, nav: adminNav() }));
  });

  app.get('/admin/verify', requireAdmin, async (req, res) => {
    const pool = poolOrNull(req, res); if (!pool || res.headersSent) return;
    const [orders] = await pool.query("SELECT o.*, m.business_name FROM orders o JOIN merchants m ON m.id = o.merchant_id WHERE o.status IN ('pending', 'processing') ORDER BY o.created_at ASC LIMIT 50");
    const [unattributed] = await pool.query("SELECT * FROM verification_events WHERE attribution_status = 'unattributed' ORDER BY received_at DESC LIMIT 20");
    const body = `
      <p class="muted">Manual reconciliation: compare each order against the merchant's official bank record before marking it successful. Check merchant, exact amount, gateway reference and UTR. A duplicate UTR for the same merchant is rejected. Sandbox orders must never be marked as real payments — use the sandbox simulator on the checkout page for test orders instead.</p>
      ${orders.length ? `<table><thead><tr><th>Reference</th><th>Merchant</th><th>Amount</th><th>Status</th><th>Mode</th><th>Created</th><th>Action</th></tr></thead><tbody>${orders.map((o) => `<tr><td><a href="/admin/orders/${escapeHtml(o.gateway_reference)}">${escapeHtml(o.gateway_reference)}</a></td><td>${escapeHtml(o.business_name)}</td><td>${formatPaise(o.amount_paise)}</td><td>${statusBadge(o.status)}</td><td>${escapeHtml(o.mode || 'live')}</td><td>${formatDate(o.created_at)}</td><td><form method="post" action="/admin/verify/${escapeHtml(o.gateway_reference)}/success" style="display:inline">${csrfField(req.csrf)}<input name="utr" placeholder="12-digit UTR" style="width:140px" required><button type="submit">Mark success (manual)</button></form> <form method="post" action="/admin/verify/${escapeHtml(o.gateway_reference)}/fail" style="display:inline">${csrfField(req.csrf)}<button type="submit">Mark failed</button></form></td></tr>`).join('')}</tbody></table>` : '<p class="muted">Verification queue is empty.</p>'}
      <h2>Unattributed verification events</h2>
      ${unattributed.length ? `<table><thead><tr><th>Source</th><th>Amount</th><th>Reference</th><th>Received</th></tr></thead><tbody>${unattributed.map((e) => `<tr><td>${escapeHtml(e.source)}</td><td>${formatPaise(e.amount_paise)}</td><td>${escapeHtml(e.external_reference || '—')}</td><td>${formatDate(e.received_at)}</td></tr>`).join('')}</tbody></table>` : '<p class="muted">No unattributed events.</p>'}
    `;
    res.send(layout({ title: 'Verification queue', body, user: { label: req.admin.email, logout: '/admin/logout' }, nav: adminNav() }));
  });

  app.post('/admin/verify/:ref/success', requireAdmin, requireCsrf, async (req, res) => {
    const pool = poolOrNull(req, res); if (!pool || res.headersSent) return;
    const utr = cleanString(req.body.utr, 20);
    const [rows] = await pool.query('SELECT * FROM orders WHERE gateway_reference = ?', [req.params.ref]);
    const order = rows[0];
    if (!order) return res.status(404).send('Order not found.');
    if (!isUtr(utr)) return res.status(400).send(layout({ title: 'Verification queue', body: alert('error', 'UTR must be exactly 12 digits.') + '<p><a href="/admin/verify">Back</a></p>' }));
    if (!['pending', 'processing'].includes(order.status)) return res.status(409).send(layout({ title: 'Verification queue', body: alert('error', `Order is already ${order.status} and cannot be marked successful.`) }));
    if (order.mode === 'sandbox') return res.status(400).send(layout({ title: 'Verification queue', body: alert('error', 'Sandbox orders must not be marked as real payments in the manual queue. Use the sandbox simulator on the checkout page for test orders.') }));
    const [dup] = await pool.query("SELECT id FROM orders WHERE merchant_id = ? AND verification_utr = ? AND status = 'success'", [order.merchant_id, utr]);
    if (dup[0]) return res.status(409).send(layout({ title: 'Verification queue', body: alert('error', 'That UTR has already been used for a successful order for this merchant. Duplicate UTR rejected.') }));
    try {
      await verifyOrderSuccess(pool, order, { source: 'manual', actorType: 'admin', actorId: req.admin.id, details: { note: 'Manual reconciliation against bank record' }, config, verificationUtr: utr, verificationSource: 'manual' });
    } catch (err) {
      return res.status(409).send(layout({ title: 'Verification queue', body: alert('error', String(err.message)) }));
    }
    res.redirect('/admin/verify');
  });

  app.post('/admin/verify/:ref/fail', requireAdmin, requireCsrf, async (req, res) => {
    const pool = poolOrNull(req, res); if (!pool || res.headersSent) return;
    const [rows] = await pool.query('SELECT * FROM orders WHERE gateway_reference = ?', [req.params.ref]);
    const order = rows[0];
    if (!order || !['pending', 'processing'].includes(order.status)) return res.status(409).send('Order cannot be marked failed.');
    await transitionOrder(pool, order, 'failed', { source: 'manual', actorType: 'admin', actorId: req.admin.id, details: { note: 'Manual verification failed' }, config });
    res.redirect('/admin/verify');
  });

  // Record a refund for a successful order. This only changes the
  // gateway record and sends a REFUNDED webhook; it does not move
  // money at the bank. The admin must record the actual bank refund
  // separately before using this. Only success -> refunded is allowed
  // by the state machine, so a pending or failed order cannot be
  // refunded through this route.
  app.post('/admin/orders/:ref/refund', requireAdmin, requireCsrf, async (req, res) => {
    const pool = poolOrNull(req, res); if (!pool || res.headersSent) return;
    const [rows] = await pool.query('SELECT * FROM orders WHERE gateway_reference = ?', [req.params.ref]);
    const order = rows[0];
    if (!order) return res.status(404).send('Order not found.');
    if (order.status !== 'success') {
      return res.status(409).send(layout({ title: 'Order', body: alert('error', `Only a successful order can be refunded. This order is ${order.status}.`) + `<p><a href="/admin/orders/${escapeHtml(order.gateway_reference)}">Back</a></p>` }));
    }
    const reason = cleanString(req.body.refund_reason || '', 500);
    try {
      await transitionOrder(pool, order, 'refunded', { source: 'admin', actorType: 'admin', actorId: req.admin.id, details: { note: 'Refund recorded by admin', reason: reason || undefined }, config });
    } catch (err) {
      return res.status(409).send(layout({ title: 'Order', body: alert('error', String(err.message)) }));
    }
    res.redirect(`/admin/orders/${escapeHtml(order.gateway_reference)}`);
  });

  app.get('/admin/webhooks', requireAdmin, async (req, res) => {
    const pool = poolOrNull(req, res); if (!pool || res.headersSent) return;
    const { page, perPage, offset } = pagination(req.query);
    const [rows] = await pool.query('SELECT w.*, m.business_name FROM webhook_deliveries w JOIN merchants m ON m.id = w.merchant_id ORDER BY w.created_at DESC LIMIT ? OFFSET ?', [perPage + 1, offset]);
    const hasMore = rows.length > perPage; const shown = hasMore ? rows.slice(0, perPage) : rows;
    const body = `
      <form method="post" action="/cron/webhooks" style="display:inline"><p class="muted">Cron retries are protected by CRON_SECRET when set. The button below runs due retries immediately for this session only if cron protection allows it.</p></form>
      ${shown.length ? `<table><thead><tr><th>Merchant</th><th>Event</th><th>Endpoint</th><th>Status</th><th>Attempts</th><th>Next retry</th><th>When</th></tr></thead><tbody>${shown.map((d) => `<tr><td>${escapeHtml(d.business_name)}</td><td>${escapeHtml(d.event_type)}</td><td>${escapeHtml(d.endpoint_url)}</td><td>${d.is_successful ? 'delivered' : 'pending/failed'} (${d.response_status || '—'})</td><td>${d.attempt_count}</td><td>${formatDate(d.next_retry_at)}</td><td>${formatDate(d.created_at)}</td></tr>`).join('')}</tbody></table>${paginationLinks('/admin/webhooks?', page, perPage, hasMore)}` : '<p class="muted">No webhook deliveries yet.</p>'}
    `;
    res.send(layout({ title: 'Webhook monitoring', body, user: { label: req.admin.email, logout: '/admin/logout' }, nav: adminNav() }));
  });

  app.get('/admin/audit', requireAdmin, async (req, res) => {
    const pool = poolOrNull(req, res); if (!pool || res.headersSent) return;
    const { page, perPage, offset } = pagination(req.query);
    const q = cleanString(req.query.q || '', 100);
    const where = q ? 'WHERE action LIKE ? OR entity_id LIKE ? OR actor_id LIKE ?' : '';
    const params = q ? [`%${q}%`, `%${q}%`, `%${q}%`] : [];
    const [rows] = await pool.query(`SELECT * FROM audit_logs ${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`, [...params, perPage + 1, offset]);
    const hasMore = rows.length > perPage; const shown = hasMore ? rows.slice(0, perPage) : rows;
    const body = `
      <form method="get" action="/admin/audit" class="inline-form"><input name="q" value="${escapeHtml(q)}" placeholder="Search action, entity or actor"><button type="submit">Filter</button></form>
      ${shown.length ? `<table><thead><tr><th>When</th><th>Actor</th><th>Action</th><th>Entity</th><th>Merchant</th><th>IP</th></tr></thead><tbody>${shown.map((a) => `<tr><td>${formatDate(a.created_at)}</td><td>${escapeHtml(a.actor_type)}: ${escapeHtml(a.actor_id || '—')}</td><td>${escapeHtml(a.action)}</td><td>${escapeHtml(a.entity_type)}: ${escapeHtml(a.entity_id)}</td><td>${escapeHtml(a.merchant_id || '—')}</td><td>${escapeHtml(a.ip_address || '—')}</td></tr>`).join('')}</tbody></table>${paginationLinks(`/admin/audit?q=${encodeURIComponent(q)}&`, page, perPage, hasMore)}` : '<p class="muted">No audit logs yet.</p>'}
    `;
    res.send(layout({ title: 'Audit logs', body, user: { label: req.admin.email, logout: '/admin/logout' }, nav: adminNav() }));
  });

  app.get('/admin/settings', requireAdmin, async (req, res) => {
    const pool = poolOrNull(req, res); if (!pool || res.headersSent) return;
    const appName = await getSetting(pool, 'app_name');
    const verificationMode = await getSetting(pool, 'verification_mode');
    const providerConfigured = Boolean(process.env.PROVIDER_WEBHOOK_SECRET);
    const observerConfigured = Boolean(process.env.OBSERVER_API_TOKEN);
    const body = `
      <p><strong>Effective verification mode (from the environment, this is what the running app actually uses): ${escapeHtml(config.verificationMode)}</strong></p>
      <p class="muted">The preference saved below is a record only. It does not change the running mode. To change the running mode, set VERIFICATION_MODE in the hosting environment and restart. The saved application name is likewise a record only; pages show the YOUPI PG brand unless the APP_NAME environment variable changes it.</p>
      <form method="post" action="/admin/settings">${csrfField(req.csrf)}${field('Application name (record only)', 'app_name', 'text', appName?.value || config.appName)}<label>Verification preference (record only)<select name="verification_mode"><option value="manual" ${verificationMode?.value === 'manual' || !verificationMode ? 'selected' : ''}>manual (default)</option><option value="observer" ${verificationMode?.value === 'observer' ? 'selected' : ''}>observer (optional external observers)</option><option value="provider" ${verificationMode?.value === 'provider' ? 'selected' : ''}>provider (only if a real provider is configured and tested)</option></select></label><p><button class="btn" type="submit">Save settings</button></p></form>
      <h2>Verification configuration status</h2>
      <ul>
        <li>Provider webhook configured: <strong>${providerConfigured ? 'Yes (secret is set in the environment; its value is never shown here)' : 'No — provider mode must not be enabled until a real provider is configured and tested'}</strong></li>
        <li>External observer token configured: <strong>${observerConfigured ? 'Yes (token is set in the environment; its value is never shown here)' : 'No — observer ingestion is disabled until OBSERVER_API_TOKEN is set'}</strong></li>
        <li>Email (SMTP) configured: <strong>${mailerConfigured() ? 'Yes (host, user and sender are set; passwords are never shown here)' : 'No — password-reset and email-verification emails cannot be sent until SMTP_HOST, SMTP_USER, SMTP_PASS and SMTP_FROM are set'}</strong></li>
        <li>Subscription billing provider: <strong>No provider configured — subscription payments are handled by manual billing only, verified by an admin. A subscription record alone is not proof of payment.</strong></li>
        <li>Checkout expiry: ${CHECKOUT_EXPIRY_MINUTES} minutes. Cron: POST /cron/webhooks and POST /cron/expire, protected by CRON_SECRET when set.</li>
      </ul>
      <p class="muted">Changing verification mode here does not by itself create a provider or observer integration. Provider and observer endpoints still validate their own secrets, amounts, merchants, order status and duplicate fingerprints before any order can succeed.</p>
      <h2>Database migrations</h2>
      <p class="muted">For an existing installation, new migrations (for example 004 for subscriptions) are not applied automatically on startup. Run them here; this never drops tables or deletes data, it only creates new tables and records the migration.</p>
      <form method="post" action="/admin/migrations">${csrfField(req.csrf)}<p><button class="btn" type="submit">Run pending migrations</button></p></form>
    `;
    res.send(layout({ title: 'Application settings', body, user: { label: req.admin.email, logout: '/admin/logout' }, nav: adminNav() }));
  });

  app.post('/admin/settings', requireAdmin, requireCsrf, async (req, res) => {
    const pool = poolOrNull(req, res); if (!pool || res.headersSent) return;
    const appName = cleanString(req.body.app_name, 255) || config.appName;
    const mode = ['manual', 'observer', 'provider'].includes(req.body.verification_mode) ? req.body.verification_mode : 'manual';
    // Do not let the saved preference pretend a provider or observer
    // exists. Provider mode needs a real, tested provider webhook
    // secret; observer mode needs an observer token. Without those,
    // the saved preference would be misleading, so refuse to save it.
    if (mode === 'provider' && !process.env.PROVIDER_WEBHOOK_SECRET) {
      return res.status(400).send(layout({ title: 'Application settings', body: alert('error', 'Provider mode cannot be saved: PROVIDER_WEBHOOK_SECRET is not set in the environment. Configure and test a real provider first.') + '<p><a href="/admin/settings">Back</a></p>' }));
    }
    if (mode === 'observer' && !process.env.OBSERVER_API_TOKEN) {
      return res.status(400).send(layout({ title: 'Application settings', body: alert('error', 'Observer mode cannot be saved: OBSERVER_API_TOKEN is not set in the environment. Configure an observer first.') + '<p><a href="/admin/settings">Back</a></p>' }));
    }
    await setSetting(pool, 'app_name', { value: appName });
    await setSetting(pool, 'verification_mode', { value: mode });
    await audit(pool, { actorType: 'admin', actorId: req.admin.id, merchantId: null, entityType: 'app', entityId: 'settings', action: 'settings_updated', details: { verification_mode: mode }, ip: req.ip });
    res.redirect('/admin/settings');
  });

  // ---------- Admin: migrations, plans, subscriptions, support, usage ----------
  app.post('/admin/migrations', requireAdmin, requireCsrf, async (req, res) => {
    const pool = poolOrNull(req, res); if (!pool || res.headersSent) return;
    let results = [];
    try {
      results = await migrate({ config, apply: true, pool });
    } catch (err) {
      return res.status(500).send(layout({ title: 'Migrations', body: `<div class="alert error">Migration failed: ${escapeHtml(String(err.message))}</div><p><a href="/admin/settings">Back to settings</a></p>`, user: { label: req.admin.email, logout: '/admin/logout' }, nav: adminNav() }));
    }
    await audit(pool, { actorType: 'admin', actorId: req.admin.id, merchantId: null, entityType: 'app', entityId: 'migrations', action: 'migrations_run', details: { results: results.map((r) => `${r.version}:${r.status}`) }, ip: req.ip });
    res.send(layout({ title: 'Migrations', body: `<div class="alert success">Migrations checked.</div><ul>${results.map((r) => `<li>${escapeHtml(r.version)}: ${escapeHtml(r.status)}</li>`).join('')}</ul><p><a class="btn secondary" href="/admin/settings">Back to settings</a></p>`, user: { label: req.admin.email, logout: '/admin/logout' }, nav: adminNav() }));
  });

  function planForm(plan, csrf) {
    const features = plan ? parsePlanFeatures(plan).join(', ') : '';
    return `<form method="post" action="${plan ? `/admin/plans/${plan.id}/edit` : '/admin/plans'}">${csrf}${field('Plan name', 'name', 'text', plan?.name || '', 'required')}${field('Slug (lowercase, letters, numbers, hyphens)', 'slug', 'text', plan?.slug || '', 'required')}${field('Description', 'description', 'text', plan?.description || '')}${field('Monthly price (paise, 0 = free)', 'price_monthly_paise', 'number', plan ? String(plan.price_monthly_paise) : '0', 'required')}${field('Annual price (paise, 0 = free)', 'price_annual_paise', 'number', plan ? String(plan.price_annual_paise) : '0', 'required')}${field('Transaction limit per month (blank = unlimited)', 'transaction_limit', 'number', plan?.transaction_limit === null || plan?.transaction_limit === undefined ? '' : String(plan.transaction_limit))}${field('API limit per month (blank = unlimited)', 'api_limit', 'number', plan?.api_limit === null || plan?.api_limit === undefined ? '' : String(plan.api_limit))}${field('Features (comma-separated)', 'features', 'text', features)}<p><button class="btn" type="submit">${plan ? 'Save plan' : 'Create plan'}</button></p></form>`;
  }

  app.get('/admin/plans', requireAdmin, async (req, res) => {
    const pool = poolOrNull(req, res); if (!pool || res.headersSent) return;
    let plans = [];
    try { const [rows] = await pool.query('SELECT * FROM subscription_plans ORDER BY price_monthly_paise ASC, created_at ASC'); plans = rows; } catch { plans = []; }
    const body = `
      ${plans.length ? '' : '<div class="alert info">No plans found. Run pending migrations from Admin &gt; Settings first (migration 004 creates the default plans), or create a plan below.</div>'}
      <p><a class="btn" href="/admin/plans/new">Create plan</a></p>
      ${plans.length ? `<table><thead><tr><th>Name</th><th>Slug</th><th>Monthly</th><th>Annual</th><th>Tx / mo</th><th>API / mo</th><th>Active</th><th>Actions</th></tr></thead><tbody>${plans.map((p) => `<tr><td>${escapeHtml(p.name)}</td><td>${escapeHtml(p.slug)}</td><td>${formatPaise(p.price_monthly_paise)}</td><td>${formatPaise(p.price_annual_paise)}</td><td>${p.transaction_limit === null ? 'Unlimited' : escapeHtml(String(p.transaction_limit))}</td><td>${p.api_limit === null ? 'Unlimited' : escapeHtml(String(p.api_limit))}</td><td>${p.is_active ? 'Yes' : 'No'}</td><td><a href="/admin/plans/${escapeHtml(p.id)}/edit">Edit</a> <form method="post" action="/admin/plans/${escapeHtml(p.id)}/toggle" style="display:inline">${csrfField(req.csrf)}<button type="submit">${p.is_active ? 'Deactivate' : 'Activate'}</button></form></td></tr>`).join('')}</tbody></table>` : ''}
    `;
    res.send(layout({ title: 'Subscription plans', body, user: { label: req.admin.email, logout: '/admin/logout' }, nav: adminNav() }));
  });

  app.get('/admin/plans/new', requireAdmin, async (req, res) => {
    res.send(layout({ title: 'Create plan', body: planForm(null, csrfField(req.csrf)), user: { label: req.admin.email, logout: '/admin/logout' }, nav: adminNav() }));
  });

  app.post('/admin/plans', requireAdmin, requireCsrf, async (req, res) => {
    const pool = poolOrNull(req, res); if (!pool || res.headersSent) return;
    const name = cleanString(req.body.name || '', 100);
    const slug = cleanString(req.body.slug || '', 100);
    const monthly = Number(req.body.price_monthly_paise || 0);
    const annual = Number(req.body.price_annual_paise || 0);
    const txLimit = req.body.transaction_limit === '' || req.body.transaction_limit === undefined ? null : Number(req.body.transaction_limit);
    const apiLimit = req.body.api_limit === '' || req.body.api_limit === undefined ? null : Number(req.body.api_limit);
    if (!name || !/^[a-z0-9][a-z0-9-]{2,98}$/.test(slug) || !Number.isInteger(monthly) || monthly < 0 || !Number.isInteger(annual) || annual < 0 || (txLimit !== null && (!Number.isInteger(txLimit) || txLimit <= 0)) || (apiLimit !== null && (!Number.isInteger(apiLimit) || apiLimit <= 0))) {
      return res.status(400).send(layout({ title: 'Create plan', body: `<div class="alert error">Check the plan name, slug, prices (integer paise, 0 or more) and limits (positive integer or blank for unlimited).</div><p><a href="/admin/plans/new">Back</a></p>`, user: { label: req.admin.email, logout: '/admin/logout' }, nav: adminNav() }));
    }
    const features = cleanString(req.body.features || '', 2000).split(',').map((s) => s.trim()).filter(Boolean);
    try {
      await pool.query('INSERT INTO subscription_plans (id, name, slug, description, price_monthly_paise, price_annual_paise, transaction_limit, api_limit, features, is_active) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1)', [randomUUID(), name, slug, cleanString(req.body.description || '', 2000) || null, monthly, annual, txLimit, apiLimit, JSON.stringify(features)]);
    } catch {
      return res.status(409).send(layout({ title: 'Create plan', body: `<div class="alert error">A plan with that slug already exists.</div><p><a href="/admin/plans/new">Back</a></p>`, user: { label: req.admin.email, logout: '/admin/logout' }, nav: adminNav() }));
    }
    await audit(pool, { actorType: 'admin', actorId: req.admin.id, merchantId: null, entityType: 'plan', entityId: slug, action: 'plan_created', details: { name }, ip: req.ip });
    res.redirect('/admin/plans');
  });

  app.get('/admin/plans/:id/edit', requireAdmin, async (req, res) => {
    const pool = poolOrNull(req, res); if (!pool || res.headersSent) return;
    const plan = await getPlanById(pool, req.params.id).catch(() => null);
    if (!plan) return res.status(404).send('Plan not found.');
    res.send(layout({ title: 'Edit plan', body: planForm(plan, csrfField(req.csrf)), user: { label: req.admin.email, logout: '/admin/logout' }, nav: adminNav() }));
  });

  app.post('/admin/plans/:id/edit', requireAdmin, requireCsrf, async (req, res) => {
    const pool = poolOrNull(req, res); if (!pool || res.headersSent) return;
    const plan = await getPlanById(pool, req.params.id).catch(() => null);
    if (!plan) return res.status(404).send('Plan not found.');
    const name = cleanString(req.body.name || '', 100);
    const slug = cleanString(req.body.slug || '', 100);
    const monthly = Number(req.body.price_monthly_paise || 0);
    const annual = Number(req.body.price_annual_paise || 0);
    const txLimit = req.body.transaction_limit === '' || req.body.transaction_limit === undefined ? null : Number(req.body.transaction_limit);
    const apiLimit = req.body.api_limit === '' || req.body.api_limit === undefined ? null : Number(req.body.api_limit);
    if (!name || !/^[a-z0-9][a-z0-9-]{2,98}$/.test(slug) || !Number.isInteger(monthly) || monthly < 0 || !Number.isInteger(annual) || annual < 0 || (txLimit !== null && (!Number.isInteger(txLimit) || txLimit <= 0)) || (apiLimit !== null && (!Number.isInteger(apiLimit) || apiLimit <= 0))) {
      return res.status(400).send(layout({ title: 'Edit plan', body: `<div class="alert error">Check the plan name, slug, prices and limits.</div><p><a href="/admin/plans">Back</a></p>`, user: { label: req.admin.email, logout: '/admin/logout' }, nav: adminNav() }));
    }
    const features = cleanString(req.body.features || '', 2000).split(',').map((s) => s.trim()).filter(Boolean);
    try {
      await pool.query('UPDATE subscription_plans SET name = ?, slug = ?, description = ?, price_monthly_paise = ?, price_annual_paise = ?, transaction_limit = ?, api_limit = ?, features = ? WHERE id = ?', [name, slug, cleanString(req.body.description || '', 2000) || null, monthly, annual, txLimit, apiLimit, JSON.stringify(features), plan.id]);
    } catch {
      return res.status(409).send(layout({ title: 'Edit plan', body: `<div class="alert error">A plan with that slug already exists.</div><p><a href="/admin/plans">Back</a></p>`, user: { label: req.admin.email, logout: '/admin/logout' }, nav: adminNav() }));
    }
    await audit(pool, { actorType: 'admin', actorId: req.admin.id, merchantId: null, entityType: 'plan', entityId: slug, action: 'plan_updated', details: { name }, ip: req.ip });
    res.redirect('/admin/plans');
  });

  app.post('/admin/plans/:id/toggle', requireAdmin, requireCsrf, async (req, res) => {
    const pool = poolOrNull(req, res); if (!pool || res.headersSent) return;
    const plan = await getPlanById(pool, req.params.id).catch(() => null);
    if (!plan) return res.status(404).send('Plan not found.');
    await pool.query('UPDATE subscription_plans SET is_active = ? WHERE id = ?', [plan.is_active ? 0 : 1, plan.id]);
    await audit(pool, { actorType: 'admin', actorId: req.admin.id, merchantId: null, entityType: 'plan', entityId: plan.slug, action: plan.is_active ? 'plan_deactivated' : 'plan_activated', details: {}, ip: req.ip });
    res.redirect('/admin/plans');
  });

  app.get('/admin/subscriptions', requireAdmin, async (req, res) => {
    const pool = poolOrNull(req, res); if (!pool || res.headersSent) return;
    const { page, perPage, offset } = pagination(req.query);
    const q = cleanString(req.query.q || '', 100);
    const status = cleanString(req.query.status || '', 20);
    const where = ['1=1']; const params = [];
    if (q) { where.push('(m.business_name LIKE ? OR m.contact_email LIKE ? OR p.name LIKE ?)'); params.push(`%${q}%`, `%${q}%`, `%${q}%`); }
    if (status) { where.push('ms.status = ?'); params.push(status); }
    let subs = [];
    try {
      const [rows] = await pool.query(`SELECT ms.*, p.name AS plan_name, m.business_name, m.contact_email FROM merchant_subscriptions ms JOIN subscription_plans p ON p.id = ms.plan_id JOIN merchants m ON m.id = ms.merchant_id WHERE ${where.join(' AND ')} ORDER BY ms.created_at DESC LIMIT ? OFFSET ?`, [...params, perPage + 1, offset]);
      subs = rows;
    } catch { subs = []; }
    const hasMore = subs.length > perPage;
    const shown = hasMore ? subs.slice(0, perPage) : subs;
    const base = `/admin/subscriptions?q=${encodeURIComponent(q)}&status=${encodeURIComponent(status)}`;
    const body = `
      ${subs.length ? '' : '<div class="alert info">No subscriptions found. Run pending migrations from Admin &gt; Settings first, or wait for a merchant to choose a plan.</div>'}
      <form method="get" action="/admin/subscriptions" class="inline-form"><input name="q" value="${escapeHtml(q)}" placeholder="Search merchant or plan"><select name="status"><option value="">All statuses</option>${['active', 'pending_payment', 'cancelled', 'expired', 'past_due'].map((s) => `<option value="${s}" ${status === s ? 'selected' : ''}>${s}</option>`).join('')}</select><button type="submit">Filter</button></form>
      ${shown.length ? `<table><thead><tr><th>Merchant</th><th>Plan</th><th>Cycle</th><th>Price</th><th>Status</th><th>Payment</th><th>Expires</th><th>Actions</th></tr></thead><tbody>${shown.map((s) => `<tr><td>${escapeHtml(s.business_name)}</td><td>${escapeHtml(s.plan_name)}</td><td>${escapeHtml(s.billing_cycle)}</td><td>${formatPaise(s.plan_price_paise)}</td><td>${escapeHtml(s.status)}</td><td>${escapeHtml(s.payment_status)}</td><td>${formatDate(s.expires_at)}</td><td>${s.status === 'pending_payment' ? `<form method="post" action="/admin/subscriptions/${escapeHtml(s.id)}/verify-payment" style="display:inline">${csrfField(req.csrf)}<input name="billing_reference" placeholder="Billing reference" style="width:140px" required><button type="submit">Verify payment (manual)</button></form>` : ''} ${s.status === 'active' ? `<form method="post" action="/admin/subscriptions/${escapeHtml(s.id)}/cancel" style="display:inline">${csrfField(req.csrf)}<button type="submit">Cancel</button></form>` : ''}</td></tr>`).join('')}</tbody></table>${paginationLinks(base, page, perPage, hasMore)}` : ''}
      <h2>Assign a plan to a merchant</h2>
      <p class="muted">Assigning a paid plan here requires a billing reference, because the admin is confirming that the subscription payment was received through manual billing. A free plan needs no reference. This does not create a provider payment.</p>
      <form method="post" action="/admin/subscriptions/assign">${csrfField(req.csrf)}${field('Merchant ID', 'merchant_id', 'text', '', 'required')}${field('Plan ID', 'plan_id', 'text', '', 'required')}<label>Billing cycle<select name="billing_cycle"><option value="monthly">Monthly</option><option value="annual">Annual</option></select></label>${field('Billing reference (required for paid plans)', 'billing_reference', 'text', '')}${field('Billing note', 'billing_note', 'text', '')}<p><button class="btn" type="submit">Assign plan</button></p></form>
    `;
    res.send(layout({ title: 'Subscriptions', body, user: { label: req.admin.email, logout: '/admin/logout' }, nav: adminNav() }));
  });

  app.post('/admin/subscriptions/:id/verify-payment', requireAdmin, requireCsrf, async (req, res) => {
    const pool = poolOrNull(req, res); if (!pool || res.headersSent) return;
    const [rows] = await pool.query('SELECT * FROM merchant_subscriptions WHERE id = ?', [req.params.id]);
    const sub = rows[0];
    if (!sub || sub.status !== 'pending_payment') return res.status(409).send('Only a pending-payment subscription can be verified.');
    const ref = cleanString(req.body.billing_reference || '', 255);
    const note = cleanString(req.body.billing_note || '', 2000);
    if (!ref) return res.status(400).send(layout({ title: 'Subscriptions', body: `<div class="alert error">A billing reference is required to verify a subscription payment.</div><p><a href="/admin/subscriptions">Back</a></p>`, user: { label: req.admin.email, logout: '/admin/logout' }, nav: adminNav() }));
    const dates = subscriptionPeriodDates(sub.billing_cycle);
    await pool.query("UPDATE merchant_subscriptions SET status = 'active', payment_status = 'verified_manual', billing_reference = ?, billing_note = ?, billing_verified_by = ?, billing_verified_at = UTC_TIMESTAMP(), renews_at = ?, expires_at = ?, grace_until = ? WHERE id = ?", [ref, note || null, req.admin.email, dates.renewsAt, dates.expiresAt, dates.graceUntil, sub.id]);
    await pool.query("UPDATE merchant_subscriptions SET status = 'cancelled', cancelled_at = UTC_TIMESTAMP() WHERE merchant_id = ? AND status = 'active' AND id != ?", [sub.merchant_id, sub.id]);
    await audit(pool, { actorType: 'admin', actorId: req.admin.id, merchantId: sub.merchant_id, entityType: 'subscription', entityId: sub.id, action: 'subscription_payment_verified_manual', details: { billing_reference: ref }, ip: req.ip });
    res.redirect('/admin/subscriptions');
  });

  app.post('/admin/subscriptions/:id/cancel', requireAdmin, requireCsrf, async (req, res) => {
    const pool = poolOrNull(req, res); if (!pool || res.headersSent) return;
    const [rows] = await pool.query('SELECT * FROM merchant_subscriptions WHERE id = ?', [req.params.id]);
    if (!rows[0] || rows[0].status !== 'active') return res.status(409).send('Only an active subscription can be cancelled.');
    await pool.query("UPDATE merchant_subscriptions SET status = 'cancelled', cancelled_at = UTC_TIMESTAMP() WHERE id = ?", [req.params.id]);
    await audit(pool, { actorType: 'admin', actorId: req.admin.id, merchantId: rows[0].merchant_id, entityType: 'subscription', entityId: req.params.id, action: 'subscription_cancelled', details: {}, ip: req.ip });
    res.redirect('/admin/subscriptions');
  });

  app.post('/admin/subscriptions/assign', requireAdmin, requireCsrf, async (req, res) => {
    const pool = poolOrNull(req, res); if (!pool || res.headersSent) return;
    const merchantId = cleanString(req.body.merchant_id || '', 36);
    const planId = cleanString(req.body.plan_id || '', 36);
    const cycle = req.body.billing_cycle === 'annual' ? 'annual' : 'monthly';
    const ref = cleanString(req.body.billing_reference || '', 255);
    const plan = await getPlanById(pool, planId).catch(() => null);
    if (!plan || !plan.is_active) return res.status(400).send(layout({ title: 'Subscriptions', body: `<div class="alert error">That plan is not available.</div><p><a href="/admin/subscriptions">Back</a></p>`, user: { label: req.admin.email, logout: '/admin/logout' }, nav: adminNav() }));
    const [mRows] = await pool.query('SELECT id FROM merchants WHERE id = ?', [merchantId]);
    if (!mRows[0]) return res.status(404).send(layout({ title: 'Subscriptions', body: `<div class="alert error">Merchant not found. Copy the merchant ID from Admin &gt; Merchants.</div><p><a href="/admin/subscriptions">Back</a></p>`, user: { label: req.admin.email, logout: '/admin/logout' }, nav: adminNav() }));
    const price = cycle === 'annual' ? Number(plan.price_annual_paise || 0) : Number(plan.price_monthly_paise || 0);
    if (price > 0 && !ref) {
      return res.status(400).send(layout({ title: 'Subscriptions', body: `<div class="alert error">A billing reference is required for a paid plan, because assigning it confirms manual billing payment was received.</div><p><a href="/admin/subscriptions">Back</a></p>`, user: { label: req.admin.email, logout: '/admin/logout' }, nav: adminNav() }));
    }
    const sub = await createSubscription(pool, { merchantId, plan, billingCycle: cycle, status: price === 0 ? 'active' : 'active', paymentStatus: price === 0 ? 'not_required' : 'verified_manual', billingReference: ref || null, billingNote: cleanString(req.body.billing_note || '', 2000) || null });
    if (price > 0) {
      await pool.query('UPDATE merchant_subscriptions SET billing_verified_by = ?, billing_verified_at = UTC_TIMESTAMP() WHERE id = ?', [req.admin.email, sub.id]);
    }
    await pool.query("UPDATE merchant_subscriptions SET status = 'cancelled', cancelled_at = UTC_TIMESTAMP() WHERE merchant_id = ? AND status = 'active' AND id != ?", [merchantId, sub.id]);
    await audit(pool, { actorType: 'admin', actorId: req.admin.id, merchantId, entityType: 'subscription', entityId: sub.id, action: 'subscription_assigned', details: { plan_slug: plan.slug, billing_cycle: cycle }, ip: req.ip });
    res.redirect('/admin/subscriptions');
  });

  app.get('/admin/usage', requireAdmin, async (req, res) => {
    const pool = poolOrNull(req, res); if (!pool || res.headersSent) return;
    const { page, perPage, offset } = pagination(req.query);
    let rows = [];
    try {
      const [r] = await pool.query(`SELECT m.id, m.business_name, m.contact_email, m.status, (SELECT COUNT(*) FROM orders o WHERE o.merchant_id = m.id AND o.created_at >= DATE_FORMAT(UTC_TIMESTAMP(), '%Y-%m-01 00:00:00')) AS orders_month, (SELECT COUNT(*) FROM order_events e JOIN orders o2 ON o2.id = e.order_id WHERE o2.merchant_id = m.id AND e.event_type = 'order_created' AND e.source = 'api' AND e.created_at >= DATE_FORMAT(UTC_TIMESTAMP(), '%Y-%m-01 00:00:00')) AS api_month FROM merchants m ORDER BY m.created_at DESC LIMIT ? OFFSET ?`, [perPage + 1, offset]);
      rows = r;
    } catch { rows = []; }
    const hasMore = rows.length > perPage;
    const shown = hasMore ? rows.slice(0, perPage) : rows;
    const enriched = [];
    for (const m of shown) {
      const current = await getCurrentSubscription(pool, m.id).catch(() => ({ plan: null }));
      enriched.push({ ...m, planName: current.plan ? (current.plan.plan_name || current.plan.name) : '—', txLimit: current.plan ? current.plan.transaction_limit : null, apiLimit: current.plan ? current.plan.api_limit : null });
    }
    const body = `
      <p class="muted">Usage for the current calendar month (UTC). Transaction and API counts are computed from orders and order events, not from a separate counter, so they cannot drift from the real order data.</p>
      ${enriched.length ? `<table><thead><tr><th>Merchant</th><th>Plan</th><th>Orders / mo</th><th>API orders / mo</th><th>Status</th></tr></thead><tbody>${enriched.map((m) => `<tr><td>${escapeHtml(m.business_name)} (${escapeHtml(m.contact_email)})</td><td>${escapeHtml(m.planName)}</td><td>${m.orders_month} / ${m.txLimit === null || m.txLimit === undefined ? 'Unlimited' : escapeHtml(String(m.txLimit))}</td><td>${m.api_month} / ${m.apiLimit === null || m.apiLimit === undefined ? 'Unlimited' : escapeHtml(String(m.apiLimit))}</td><td>${escapeHtml(m.status)}</td></tr>`).join('')}</tbody></table>${paginationLinks('/admin/usage?', page, perPage, hasMore)}` : '<p class="muted">No merchants yet, or usage tables are not available until migrations are run.</p>'}
    `;
    res.send(layout({ title: 'API usage and quotas', body, user: { label: req.admin.email, logout: '/admin/logout' }, nav: adminNav() }));
  });

  app.get('/admin/support', requireAdmin, async (req, res) => {
    const pool = poolOrNull(req, res); if (!pool || res.headersSent) return;
    const { page, perPage, offset } = pagination(req.query);
    const status = cleanString(req.query.status || '', 20);
    let rows = [];
    try {
      const where = status ? 'WHERE status = ?' : '';
      const params = status ? [status] : [];
      const [r] = await pool.query(`SELECT * FROM support_messages ${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`, [...params, perPage + 1, offset]);
      rows = r;
    } catch { rows = []; }
    const hasMore = rows.length > perPage;
    const shown = hasMore ? rows.slice(0, perPage) : rows;
    const body = `
      <form method="get" action="/admin/support" class="inline-form"><select name="status"><option value="">All statuses</option>${['open', 'answered', 'closed'].map((s) => `<option value="${s}" ${status === s ? 'selected' : ''}>${s}</option>`).join('')}</select><button type="submit">Filter</button></form>
      ${shown.length ? `<table><thead><tr><th>When</th><th>Name</th><th>Email</th><th>Subject</th><th>Status</th><th>Actions</th></tr></thead><tbody>${shown.map((m) => `<tr><td>${formatDate(m.created_at)}</td><td>${escapeHtml(m.name)}</td><td>${escapeHtml(m.email)}</td><td>${escapeHtml(m.subject)}</td><td>${escapeHtml(m.status)}</td><td><a href="/admin/support/${escapeHtml(m.id)}">View / reply</a></td></tr>`).join('')}</tbody></table>${paginationLinks(`/admin/support?status=${encodeURIComponent(status)}&`, page, perPage, hasMore)}` : '<p class="muted">No support messages yet.</p>'}
    `;
    res.send(layout({ title: 'Support messages', body, user: { label: req.admin.email, logout: '/admin/logout' }, nav: adminNav() }));
  });

  app.get('/admin/support/:id', requireAdmin, async (req, res) => {
    const pool = poolOrNull(req, res); if (!pool || res.headersSent) return;
    const [rows] = await pool.query('SELECT * FROM support_messages WHERE id = ?', [req.params.id]);
    if (!rows[0]) return res.status(404).send('Support message not found.');
    const m = rows[0];
    const body = `
      <p><strong>From:</strong> ${escapeHtml(m.name)} (${escapeHtml(m.email)}) · <strong>When:</strong> ${formatDate(m.created_at)} · <strong>Status:</strong> ${escapeHtml(m.status)}</p>
      <h2>Message</h2><p>${escapeHtml(m.message)}</p>
      ${m.admin_reply ? `<h2>Admin reply</h2><p>${escapeHtml(m.admin_reply)}</p><p class="muted">Replied: ${formatDate(m.replied_at)}</p>` : ''}
      <h2>Reply</h2>
      <form method="post" action="/admin/support/${escapeHtml(m.id)}/reply">${csrfField(req.csrf)}<label>Reply<textarea name="admin_reply" rows="5" required style="width:100%;max-width:640px;padding:.5rem;border:1px solid #cbd5e1;border-radius:8px"></textarea></label><label>Status<select name="status"><option value="answered" ${m.status === 'answered' ? 'selected' : ''}>answered</option><option value="open" ${m.status === 'open' ? 'selected' : ''}>open</option><option value="closed" ${m.status === 'closed' ? 'selected' : ''}>closed</option></select></label><p><button class="btn" type="submit">Save reply</button></p></form>
      <p class="muted">The reply is stored here. It is sent by email only if an email service is configured for this installation; otherwise, the merchant sees it only if you contact them separately.</p>
    `;
    res.send(layout({ title: 'Support message', body, user: { label: req.admin.email, logout: '/admin/logout' }, nav: adminNav() }));
  });

  app.post('/admin/support/:id/reply', requireAdmin, requireCsrf, async (req, res) => {
    const pool = poolOrNull(req, res); if (!pool || res.headersSent) return;
    const [rows] = await pool.query('SELECT * FROM support_messages WHERE id = ?', [req.params.id]);
    if (!rows[0]) return res.status(404).send('Support message not found.');
    const reply = cleanString(req.body.admin_reply || '', 5000);
    const status = ['open', 'answered', 'closed'].includes(req.body.status) ? req.body.status : 'answered';
    if (!reply) return res.status(400).send(layout({ title: 'Support message', body: `<div class="alert error">Reply cannot be empty.</div><p><a href="/admin/support/${escapeHtml(req.params.id)}">Back</a></p>`, user: { label: req.admin.email, logout: '/admin/logout' }, nav: adminNav() }));
    await pool.query('UPDATE support_messages SET admin_reply = ?, status = ?, replied_at = UTC_TIMESTAMP() WHERE id = ?', [reply, status, req.params.id]);
    await audit(pool, { actorType: 'admin', actorId: req.admin.id, merchantId: rows[0].merchant_id, entityType: 'support_message', entityId: req.params.id, action: 'support_replied', details: { status }, ip: req.ip });
    if (mailerConfigured()) {
      try { await sendMail({ to: rows[0].email, subject: `Re: ${rows[0].subject}`, text: reply }); } catch {}
    }
    res.redirect(`/admin/support/${escapeHtml(req.params.id)}`);
  });

  // ---------- Merchant REST API ----------
  async function apiAuth(req, res, next) {
    const pool = poolOrNull(req, res); if (!pool || res.headersSent) return;
    const header = req.headers.authorization || '';
    const key = header.startsWith('Bearer ') ? header.slice(7).trim() : (req.headers['x-api-key'] || '').trim();
    if (!key) return res.status(401).json({ error: 'API key required' });
    if (!key.startsWith('sk_')) return res.status(401).json({ error: 'A secret API key is required for order creation. Public keys must not be used here.' });
    const prefix = key.slice(0, 12);
    const [rows] = await pool.query("SELECT * FROM merchant_api_keys WHERE key_prefix = ? AND key_type = 'secret' AND status = 'active'", [prefix]);
    const found = rows.find((k) => {
      try { return sha256Hex(key) === k.key_hash; } catch { return false; }
    });
    if (!found) return res.status(401).json({ error: 'Invalid API key' });
    const [merchants] = await pool.query('SELECT * FROM merchants WHERE id = ?', [found.merchant_id]);
    const merchant = merchants[0];
    if (!merchant) return res.status(401).json({ error: 'Invalid API key' });
    await pool.query('UPDATE merchant_api_keys SET last_used_at = UTC_TIMESTAMP() WHERE id = ?', [found.id]);
    req.apiMerchant = merchant;
    req.apiKey = found;
    return next();
  }

  app.post('/api/v1/orders', apiLimiter, apiAuth, async (req, res) => {
    const pool = poolOrNull(req, res); if (!pool || res.headersSent) return;
    const merchant = req.apiMerchant;
    if (merchant.status !== 'approved') return res.status(403).json({ error: `Merchant account is ${merchant.status}. API orders require an approved account.` });
    const allowed = await checkOrderAllowed(pool, merchant, 'api').catch(() => ({ allowed: true }));
    if (!allowed.allowed) return res.status(403).json({ error: allowed.reason });
    const merchantOrderId = cleanString(req.body.merchant_order_id, 255);
    const amountPaise = parseAmountPaise(req.body);
    const mode = req.body.mode === 'sandbox' ? 'sandbox' : 'live';
    const idempotencyKey = cleanString(req.body.idempotency_key || '', 255) || null;
    if (!merchantOrderId || !amountPaise) return res.status(400).json({ error: 'merchant_order_id and a positive amount (amount_paise or amount) are required.' });
    // Currency is INR only. Previously a non-INR currency was silently
    // ignored and the order was still created as INR, which would
    // mislead the caller. Reject it explicitly instead.
    if (req.body.currency !== undefined && req.body.currency !== null && req.body.currency !== '' && String(req.body.currency).toUpperCase() !== 'INR') {
      return res.status(400).json({ error: 'Only INR is supported. Set currency to INR or omit it.' });
    }
    // Return URLs are linked from the checkout page, so only plain
    // http(s) URLs are accepted. javascript: and data: URLs are rejected.
    if (req.body.return_url !== undefined && req.body.return_url !== null && req.body.return_url !== '' && typeof req.body.return_url !== 'string') {
      return res.status(400).json({ error: 'return_url must be a valid http:// or https:// URL.' });
    }
    const returnUrlRaw = cleanString(req.body.return_url || '', 1024);
    const returnUrl = validateReturnUrl(returnUrlRaw);
    if (returnUrlRaw && returnUrl === null) {
      return res.status(400).json({ error: 'return_url must be a valid http:// or https:// URL.' });
    }
    if (idempotencyKey) {
      const [existing] = await pool.query('SELECT * FROM orders WHERE merchant_id = ? AND idempotency_key = ?', [merchant.id, idempotencyKey]);
      if (existing[0]) return res.json({ order: publicOrder(existing[0], merchant, config), idempotent: true });
    }
    const [dup] = await pool.query('SELECT * FROM orders WHERE merchant_id = ? AND merchant_order_id = ?', [merchant.id, merchantOrderId]);
    if (dup[0]) return res.status(409).json({ error: 'merchant_order_id already exists for this merchant.', gateway_reference: dup[0].gateway_reference });
    const upiId = merchant.upi_id;
    if (!upiId) return res.status(400).json({ error: 'Merchant UPI ID is not configured.' });
    const [accounts] = await pool.query('SELECT * FROM receiving_accounts WHERE merchant_id = ? AND upi_id = ? AND is_active = 1', [merchant.id, upiId]);
    const gatewayReference = generateGatewayReference();
    const id = randomUUID();
    try {
      await pool.query(
        'INSERT INTO orders (id, merchant_id, merchant_order_id, gateway_reference, receiving_account_id, amount_paise, currency, status, method, upi_id_used, customer_name, customer_email, customer_phone, return_url, metadata, verification_source, mode, expires_at, idempotency_key) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, DATE_ADD(UTC_TIMESTAMP(), INTERVAL ? MINUTE), ?)',
        [id, merchant.id, merchantOrderId, gatewayReference, accounts[0]?.id || null, amountPaise, 'INR', 'pending', 'upi', upiId, cleanString(req.body.customer_name || '', 255) || null, cleanString(req.body.customer_email || '', 255) || null, cleanString(req.body.customer_phone || '', 20) || null, returnUrl || null, JSON.stringify(req.body.metadata || {}), 'none', mode, CHECKOUT_EXPIRY_MINUTES, idempotencyKey],
      );
    } catch (err) {
      return res.status(409).json({ error: `Order creation failed: ${String(err?.message || err)}` });
    }
    const [fresh] = await pool.query('SELECT * FROM orders WHERE id = ?', [id]);
    await addOrderEvent(pool, { orderId: id, eventType: 'order_created', statusFrom: null, statusTo: 'pending', source: 'api', actorType: 'merchant', actorId: merchant.id, details: { mode } });
    await audit(pool, { actorType: 'merchant', actorId: merchant.id, merchantId: merchant.id, entityType: 'order', entityId: gatewayReference, action: 'order_created_api', details: { mode, amount_paise: amountPaise }, ip: req.ip });
    return res.status(201).json({ order: publicOrder(fresh[0], merchant, config), idempotent: false });
  });

  function publicOrder(order, merchant, cfg) {
    return {
      gateway_reference: order.gateway_reference,
      merchant_order_id: order.merchant_order_id,
      merchant: merchant.business_name,
      amount_paise: Number(order.amount_paise),
      amount: formatPaise(order.amount_paise),
      currency: order.currency || 'INR',
      status: order.status,
      mode: order.mode || 'live',
      verification_source: order.verification_source || 'none',
      utr: order.verification_utr || null,
      checkout_url: `${cfg.baseUrl || ''}/checkout/${order.gateway_reference}`,
      expires_at: order.expires_at,
      created_at: order.created_at,
    };
  }

  app.get('/api/v1/orders/:ref', apiLimiter, apiAuth, async (req, res) => {
    const pool = poolOrNull(req, res); if (!pool || res.headersSent) return;
    const [rows] = await pool.query('SELECT * FROM orders WHERE gateway_reference = ? AND merchant_id = ?', [req.params.ref, req.apiMerchant.id]);
    if (!rows[0]) return res.status(404).json({ error: 'Order not found for this merchant.' });
    res.json({ order: publicOrder(rows[0], req.apiMerchant, config) });
  });

  app.get('/api/public/orders/:ref/status', async (req, res) => {
    const pool = poolOrNull(req, res); if (!pool || res.headersSent) return;
    const [rows] = await pool.query('SELECT o.*, m.business_name FROM orders o JOIN merchants m ON m.id = o.merchant_id WHERE o.gateway_reference = ?', [req.params.ref]);
    const order = rows[0];
    if (!order) return res.status(404).json({ error: 'Order not found.' });
    const fresh = await expireOrderIfOverdue(pool, order, config);
    res.json({ gateway_reference: fresh.gateway_reference, status: fresh.status, amount_paise: Number(fresh.amount_paise), verification_source: fresh.verification_source || 'none', mode: fresh.mode || 'live', return_url: fresh.return_url || null });
  });

  // ---------- External observer ingestion ----------
  app.post('/api/v1/observers/events', apiLimiter, async (req, res) => {
    const pool = poolOrNull(req, res); if (!pool || res.headersSent) return;
    const token = process.env.OBSERVER_API_TOKEN || '';
    if (!token) return res.status(501).json({ error: 'observer_not_configured', message: 'External observer ingestion is disabled until OBSERVER_API_TOKEN is set.' });
    const presented = (req.headers['x-observer-token'] || '').trim();
    if (!presented || presented !== token) return res.status(401).json({ error: 'Invalid observer token' });
    const event = {
      source: 'observer',
      merchantId: req.body.merchant_id || req.body.merchantId,
      orderId: req.body.gateway_reference || req.body.gatewayReference || req.body.order_id,
      amountPaise: req.body.amount_paise || req.body.amountPaise,
      utr: req.body.utr,
      fingerprintHash: req.body.fingerprint_hash || (req.body.utr ? sha256Hex(`${req.body.merchant_id}:${req.body.utr}:${req.body.amount_paise}`) : null),
    };
    const errors = validateVerificationEvent(event);
    if (errors.length) return res.status(400).json({ error: errors.join(' ') });
    const [existing] = await pool.query('SELECT * FROM verification_events WHERE fingerprint_hash = ?', [event.fingerprintHash]);
    if (existing[0]) return res.json({ received: true, duplicate: true });
    const [orders] = await pool.query('SELECT * FROM orders WHERE gateway_reference = ? AND merchant_id = ?', [event.orderId, event.merchantId]);
    const order = orders[0];
    await pool.query(
      'INSERT INTO verification_events (id, merchant_id, order_id, source, amount_paise, external_reference, fingerprint_hash, raw_payload, attribution_status, attributed_order_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [randomUUID(), event.merchantId, order?.id || null, 'observer', event.amountPaise, event.utr || null, event.fingerprintHash, JSON.stringify(req.body), order ? 'attributed' : 'unattributed', order?.id || null],
    );
    if (order && ['pending', 'processing'].includes(order.status) && Number(order.amount_paise) === Number(event.amountPaise)) {
      await verifyOrderSuccess(pool, order, { source: 'observer', actorType: 'observer', actorId: 'external_observer', details: {}, config, verificationUtr: event.utr, verificationSource: 'observer' });
      return res.json({ received: true, status: 'success' });
    }
    return res.json({ received: true, status: 'held_for_review' });
  });

  // ---------- Checkout ----------
  app.get('/checkout/:ref', async (req, res) => {
    const pool = poolOrNull(req, res); if (!pool || res.headersSent) return;
    const [rows] = await pool.query('SELECT o.*, m.business_name, m.payee_name, m.status AS merchant_status FROM orders o JOIN merchants m ON m.id = o.merchant_id WHERE o.gateway_reference = ?', [req.params.ref]);
    let order = rows[0];
    if (!order) return res.status(404).send(layout({ title: 'Checkout not found', body: '<p>Checkout not found. Check the link from the merchant.</p>' }));
    order = await expireOrderIfOverdue(pool, order, config);
    if (order.merchant_status === 'suspended') {
      return res.send(layout({ title: 'Checkout unavailable', body: '<div class="alert error">This merchant account is suspended. Checkout is unavailable.</div>' }));
    }
    if (['success', 'failed', 'expired', 'cancelled', 'refunded'].includes(order.status)) {
      return res.send(layout({ title: `Order ${order.status}`, body: `<p>Order status: ${statusBadge(order.status)}</p><p>Amount: ${formatPaise(order.amount_paise)} &nbsp; Verified by: ${escapeHtml(order.verification_source || 'none')} &nbsp; UTR: ${escapeHtml(order.verification_utr || '—')}</p>${order.return_url ? `<p><a class="btn" href="${escapeHtml(order.return_url)}">Return to merchant</a></p>` : ''}` }));
    }
    // FIFO queue: only the earliest pending/processing order for this merchant
    // shows a QR code. Later orders wait and poll for their turn.
    // First expire any overdue orders for this merchant so a stale order
    // cannot block the queue forever.
    try {
      const [overdue] = await pool.query("SELECT * FROM orders WHERE merchant_id = ? AND status IN ('pending', 'processing') AND expires_at IS NOT NULL AND expires_at <= UTC_TIMESTAMP() AND id != ?", [order.merchant_id, order.id]);
      for (const overdueOrder of overdue) {
        await expireOrderIfOverdue(pool, overdueOrder, config).catch(() => {});
      }
    } catch { /* queue check below still applies */ }
    const position = await queuePosition(pool, order).catch(() => 1);
    if (position > 1) {
      return res.send(layout({ title: 'Waiting for your turn', body: `<div class="alert info">You are in the payment queue for this merchant.</div><p>Your queue position: <strong>${position}</strong>. Only one payment is shown a QR code at a time for the same UPI ID, so that bank alerts can be matched to the correct order. This page refreshes automatically.</p><script>setTimeout(function(){ window.location.reload(); }, 10000);</script>` }));
    }
    const upiUri = buildUpiUri({ upiId: order.upi_id_used, payeeName: order.payee_name || order.business_name, amountPaise: Number(order.amount_paise), transactionRef: order.gateway_reference });
    let qrDataUrl = '';
    try { qrDataUrl = await QRCode.toDataURL(upiUri, { margin: 1, width: 280 }); } catch { qrDataUrl = ''; }
    const isSandbox = (order.mode || 'live') === 'sandbox';
    const body = `
      ${isSandbox ? '<div class="alert info"><strong>TEST / SANDBOX ORDER.</strong> This is not a real payment. Use the sandbox simulator below. No real money is involved and no real bank confirmation will be produced.</div>' : ''}
      <div class="checkout">
        <p><strong>Pay to:</strong> ${escapeHtml(order.business_name)} (${escapeHtml(order.payee_name || '')})</p>
        <p><strong>UPI ID:</strong> ${escapeHtml(order.upi_id_used)} &nbsp; <strong>Amount:</strong> ${formatPaise(order.amount_paise)} &nbsp; <strong>Order:</strong> ${escapeHtml(order.merchant_order_id)}</p>
        <p><strong>Status:</strong> <span id="order-status">${escapeHtml(order.status)}</span> &nbsp; <span id="order-note" class="muted">Checking for verification…</span></p>
        ${qrDataUrl ? `<img class="qr" src="${qrDataUrl}" alt="UPI QR code">` : `<p class="muted">QR code could not be generated. Use the UPI link below.</p>`}
        <p><a class="btn" href="${escapeHtml(upiUri)}">Pay with a UPI app</a></p>
        <p class="muted">UPI apps: GPay, PhonePe, Paytm, BHIM, CRED and other UPI apps can open the link above on a mobile device. On desktop, scan the QR code with your UPI app.</p>
        <p><code>${escapeHtml(upiUri)}</code></p>
        <form method="post" action="/checkout/${escapeHtml(order.gateway_reference)}/paid"><p><button class="btn secondary" type="submit">I have paid — check my payment</button></p><p class="muted">This does <strong>not</strong> mark the order successful. It moves the order to “processing” for verification (manual reconciliation, a configured provider, or an optional external observer).</p></form>
        ${isSandbox ? `<form method="post" action="/checkout/${escapeHtml(order.gateway_reference)}/sandbox-simulate"><p><button class="btn" type="submit">Simulate successful payment (sandbox only)</button></p><p class="muted">Sandbox only. This creates a clearly-labelled TEST success with a synthetic reference. It must never be used for a live order.</p></form>` : ''}
        <form method="post" action="/checkout/${escapeHtml(order.gateway_reference)}/cancel"><p><button type="submit">Cancel this order</button></p></form>
        ${order.return_url ? `<p><a href="${escapeHtml(order.return_url)}">Return to merchant</a></p>` : ''}
      </div>
      <script>
        (function(){
          var ref = ${JSON.stringify(order.gateway_reference)};
          function poll(){
            fetch('/api/public/orders/' + encodeURIComponent(ref) + '/status').then(function(r){ return r.json(); }).then(function(d){
              var el = document.getElementById('order-status');
              if (el) el.textContent = d.status;
              if (['success','failed','expired','cancelled','refunded'].indexOf(d.status) >= 0) { window.location.reload(); }
            }).catch(function(){});
          }
          setInterval(poll, 5000); poll();
        })();
      </script>
    `;
    res.send(layout({ title: `Checkout — ${order.business_name}`, body }));
  });

  app.post('/checkout/:ref/paid', apiLimiter, async (req, res) => {
    const pool = poolOrNull(req, res); if (!pool || res.headersSent) return;
    const [rows] = await pool.query('SELECT * FROM orders WHERE gateway_reference = ?', [req.params.ref]);
    const order = rows[0];
    if (!order) return res.status(404).send('Order not found.');
    const fresh = await expireOrderIfOverdue(pool, order, config);
    if (fresh.status === 'pending') {
      await transitionOrder(pool, fresh, 'processing', { source: 'customer', actorType: 'customer', actorId: null, details: { note: 'Customer clicked I have paid; verification pending, not success' }, config });
    }
    res.redirect(`/checkout/${req.params.ref}`);
  });

  app.post('/checkout/:ref/sandbox-simulate', apiLimiter, async (req, res) => {
    const pool = poolOrNull(req, res); if (!pool || res.headersSent) return;
    const [rows] = await pool.query('SELECT * FROM orders WHERE gateway_reference = ?', [req.params.ref]);
    const order = rows[0];
    if (!order) return res.status(404).send('Order not found.');
    if ((order.mode || 'live') !== 'sandbox') return res.status(403).send(layout({ title: 'Sandbox only', body: alert('error', 'Sandbox simulation is only allowed for sandbox orders. This is a live order and must be verified, not simulated.') }));
    const fresh = await expireOrderIfOverdue(pool, order, config);
    if (!['pending', 'processing'].includes(fresh.status)) return res.redirect(`/checkout/${req.params.ref}`);
    if (fresh.status === 'pending') {
      await transitionOrder(pool, fresh, 'processing', { source: 'sandbox', actorType: 'system', actorId: 'sandbox', details: {}, config });
      const [again] = await pool.query('SELECT * FROM orders WHERE id = ?', [order.id]);
      await transitionOrder(pool, again[0], 'success', { source: 'sandbox', actorType: 'system', actorId: 'sandbox', details: { note: 'Sandbox simulator only; synthetic reference, not a bank confirmation' }, config, verificationUtr: 'SANDBOX000001', verificationSource: 'sandbox' });
    } else {
      await transitionOrder(pool, fresh, 'success', { source: 'sandbox', actorType: 'system', actorId: 'sandbox', details: { note: 'Sandbox simulator only; synthetic reference, not a bank confirmation' }, config, verificationUtr: 'SANDBOX000001', verificationSource: 'sandbox' });
    }
    res.redirect(`/checkout/${req.params.ref}`);
  });

  app.post('/checkout/:ref/cancel', apiLimiter, async (req, res) => {
    const pool = poolOrNull(req, res); if (!pool || res.headersSent) return;
    const [rows] = await pool.query('SELECT * FROM orders WHERE gateway_reference = ?', [req.params.ref]);
    const order = rows[0];
    if (!order) return res.status(404).send('Order not found.');
    if (['pending', 'processing'].includes(order.status)) {
      await transitionOrder(pool, order, 'cancelled', { source: 'customer', actorType: 'customer', actorId: null, details: {}, config });
    }
    res.redirect(`/checkout/${req.params.ref}`);
  });

  // ---------- Cron (request-driven, protected) ----------
  function requireCron(req, res, next) {
    const secret = process.env.CRON_SECRET || '';
    if (!secret) return res.status(503).json({ error: 'Cron endpoints are disabled until CRON_SECRET is set in the hosting environment.' });
    if ((req.headers['x-cron-secret'] || '') !== secret) return res.status(401).json({ error: 'Invalid cron secret' });
    return next();
  }

  app.post('/cron/webhooks', requireCron, async (req, res) => {
    const pool = poolOrNull(req, res); if (!pool || res.headersSent) return;
    const results = await retryDueDeliveries(pool, config, { limit: 20 });
    res.json({ retried: results.length, results });
  });

  app.post('/cron/expire', requireCron, async (req, res) => {
    const pool = poolOrNull(req, res); if (!pool || res.headersSent) return;
    const [overdue] = await pool.query("SELECT * FROM orders WHERE status IN ('pending', 'processing') AND expires_at IS NOT NULL AND expires_at <= UTC_TIMESTAMP()");
    let expired = 0;
    for (const order of overdue) {
      try {
        await transitionOrder(pool, order, 'expired', { source: 'system', actorType: 'system', actorId: 'cron', details: { reason: 'checkout_expired' }, config });
        expired += 1;
      } catch { /* already terminal */ }
    }
    res.json({ expired });
  });

  // ---------- Fallbacks ----------
  app.use((req, res) => {
    if (req.accepts('html')) return res.status(404).send(layout({ title: 'Not found', body: '<p>Page not found.</p>' }));
    res.status(404).json({ error: 'Not found' });
  });

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    if (err?.type === 'entity.too.large') return res.status(413).json({ error: 'Payload too large' });
    if (err instanceof SyntaxError) return res.status(400).json({ error: 'Malformed JSON body' });
    res.status(500).json({ error: 'Internal error' });
  });

  return app;
}
