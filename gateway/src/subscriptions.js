// SaaS subscription helpers. All enforcement happens here, on the
// server, before an order is created. A subscription record alone is
// never proof of payment: a paid plan is only "active" after an admin
// records manual billing verification (or a configured provider
// confirmation, which is not included in this codebase).
import { randomUUID } from 'node:crypto';
import { sha256Hex } from './crypto.js';

export function monthStartSql() {
  // First instant of the current UTC calendar month, as a MySQL
  // DATETIME string. Usage is counted per calendar month.
  const now = new Date();
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}-01 00:00:00`;
}

export const FALLBACK_PLANS = [
  { id: null, name: 'Free', slug: 'free', description: 'Start with UPI checkout, dashboard and manual verification.', price_monthly_paise: 0, price_annual_paise: 0, transaction_limit: 100, api_limit: 100, features: ['UPI QR checkout', 'Merchant dashboard', 'Manual verification', 'Webhooks'], is_active: 1 },
  { id: null, name: 'Basic', slug: 'basic', description: 'For small stores getting started with online payments.', price_monthly_paise: 49900, price_annual_paise: 499000, transaction_limit: 1000, api_limit: 5000, features: ['Everything in Free', 'Higher transaction limits', 'API access', 'Webhook retries'], is_active: 1 },
  { id: null, name: 'Pro', slug: 'pro', description: 'For growing businesses with higher volume.', price_monthly_paise: 149900, price_annual_paise: 1499000, transaction_limit: 10000, api_limit: 50000, features: ['Everything in Basic', 'Priority support', 'Usage reports', 'Subscription management'], is_active: 1 },
  { id: null, name: 'Business', slug: 'business', description: 'For high-volume merchants. No monthly transaction cap in this plan.', price_monthly_paise: 399900, price_annual_paise: 3999000, transaction_limit: null, api_limit: null, features: ['Everything in Pro', 'Unlimited transactions', 'Unlimited API calls', 'Dedicated support channel'], is_active: 1 },
];

export async function getActivePlans(pool) {
  try {
    const [rows] = await pool.query(
      "SELECT * FROM subscription_plans WHERE is_active = 1 ORDER BY price_monthly_paise ASC, created_at ASC",
    );
    return rows;
  } catch {
    // The 004 migration has not run yet on an older database.
    // Callers show the fallback defaults instead of crashing, and
    // the admin can run pending migrations from Settings.
    return [];
  }
}

export async function getPlanById(pool, planId) {
  if (!planId) return null;
  const [rows] = await pool.query('SELECT * FROM subscription_plans WHERE id = ?', [planId]);
  return rows[0] || null;
}

export async function getPlanBySlug(pool, slug) {
  const [rows] = await pool.query('SELECT * FROM subscription_plans WHERE slug = ?', [slug]);
  return rows[0] || null;
}

export function parsePlanFeatures(plan) {
  if (!plan) return [];
  if (Array.isArray(plan.features)) return plan.features;
  try {
    const v = typeof plan.features === 'string' ? JSON.parse(plan.features) : plan.features;
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

// The merchant's current subscription. Rules, in order:
//  - An "active" subscription whose expiry (if any) has not passed, or
//    which is still inside its grace period, is current.
//  - A "pending_payment" subscription is NOT current; the previous
//    active subscription (if any) remains current until the new one
//    is verified.
//  - A merchant with no subscription row at all is treated as Free,
//    without creating a row on read. This keeps merchants created
//    before subscriptions existed working, with the Free limits.
export async function getCurrentSubscription(pool, merchantId) {
  try {
    const [subs] = await pool.query(
      "SELECT ms.*, p.name AS plan_name, p.slug AS plan_slug, p.description AS plan_description, p.price_monthly_paise AS plan_monthly, p.price_annual_paise AS plan_annual, p.transaction_limit, p.api_limit, p.features AS plan_features FROM merchant_subscriptions ms JOIN subscription_plans p ON p.id = ms.plan_id WHERE ms.merchant_id = ? AND ms.status = 'active' ORDER BY ms.created_at DESC LIMIT 1",
      [merchantId],
    );
    if (subs[0]) {
      const sub = subs[0];
      const now = new Date();
      const expired = sub.expires_at && new Date(sub.expires_at).getTime() < now.getTime();
      const inGrace = expired && sub.grace_until && new Date(sub.grace_until).getTime() >= now.getTime();
      return { subscription: sub, plan: sub, isGrace: Boolean(expired && inGrace), isExpired: Boolean(expired && !inGrace), isFreeFallback: false };
    }
    const free = await getPlanBySlug(pool, 'free');
    if (free) {
      return {
        subscription: null,
        plan: { ...free, plan_name: free.name, plan_slug: free.slug, plan_description: free.description, plan_monthly: free.price_monthly_paise, plan_annual: free.price_annual_paise },
        isGrace: false, isExpired: false, isFreeFallback: true,
      };
    }
  } catch {
    // 004 tables missing (older database, migration not run yet):
    // fall back to the Free defaults instead of blocking the merchant.
    const free = FALLBACK_PLANS[0];
    return {
      subscription: null,
      plan: { ...free, plan_name: free.name, plan_slug: free.slug, plan_description: free.description, plan_monthly: free.price_monthly_paise, plan_annual: free.price_annual_paise },
      isGrace: false, isExpired: false, isFreeFallback: true, tablesMissing: true,
    };
  }
  return { subscription: null, plan: null, isGrace: false, isExpired: false, isFreeFallback: true };
}

export async function getUsage(pool, merchantId) {
  const start = monthStartSql();
  try {
    const [orders] = await pool.query(
      'SELECT COUNT(*) AS n FROM orders WHERE merchant_id = ? AND created_at >= ?',
      [merchantId, start],
    );
    const [apiOrders] = await pool.query(
      "SELECT COUNT(*) AS n FROM order_events WHERE order_id IN (SELECT id FROM orders WHERE merchant_id = ?) AND event_type = 'order_created' AND source = 'api' AND created_at >= ?",
      [merchantId, start],
    );
    return { ordersThisMonth: Number(orders[0]?.n || 0), apiOrdersThisMonth: Number(apiOrders[0]?.n || 0), periodStart: start };
  } catch {
    return { ordersThisMonth: 0, apiOrdersThisMonth: 0, periodStart: start };
  }
}

// Returns { allowed: true } or { allowed: false, reason }.
// "api" orders count against both the transaction limit and the API
// limit; dashboard orders count only against the transaction limit.
export async function checkOrderAllowed(pool, merchant, source) {
  if (merchant.status !== 'approved') {
    return { allowed: false, reason: `Merchant account is ${merchant.status}. Orders require an approved account.` };
  }
  const current = await getCurrentSubscription(pool, merchant.id);
  if (!current.plan) return { allowed: true, current };
  // If the subscription tables do not exist yet (004 not run), do
  // not block existing merchants with a fallback limit. The admin
  // must run pending migrations first; until then, old behaviour
  // (no subscription enforcement) is preserved.
  if (current.tablesMissing) return { allowed: true, current, usage: await getUsage(pool, merchant.id) };
  if (current.isExpired) {
    return { allowed: false, reason: 'Subscription has expired and the grace period has ended. Renew or change your plan to continue creating orders.', current };
  }
  const usage = await getUsage(pool, merchant.id);
  if (current.plan.transaction_limit !== null && current.plan.transaction_limit !== undefined && usage.ordersThisMonth >= Number(current.plan.transaction_limit)) {
    return { allowed: false, reason: 'Plan transaction limit for this month has been reached. Upgrade your plan to create more orders.', current, usage };
  }
  if (source === 'api' && current.plan.api_limit !== null && current.plan.api_limit !== undefined && usage.apiOrdersThisMonth >= Number(current.plan.api_limit)) {
    return { allowed: false, reason: 'Plan API limit for this month has been reached. Upgrade your plan to create more API orders.', current, usage };
  }
  return { allowed: true, current, usage };
}

export function subscriptionPeriodDates(billingCycle) {
  const now = new Date();
  const renews = new Date(now);
  if (billingCycle === 'annual') renews.setFullYear(renews.getFullYear() + 1);
  else renews.setMonth(renews.getMonth() + 1);
  const grace = new Date(renews);
  grace.setDate(grace.getDate() + 7);
  const fmt = (d) => d.toISOString().slice(0, 19).replace('T', ' ');
  return { renewsAt: fmt(renews), expiresAt: fmt(renews), graceUntil: fmt(grace) };
}

export async function createSubscription(pool, { merchantId, plan, billingCycle = 'monthly', status = 'pending_payment', paymentStatus = 'pending_manual', billingReference = null, billingNote = null }) {
  const id = randomUUID();
  const price = billingCycle === 'annual' ? Number(plan.price_annual_paise || 0) : Number(plan.price_monthly_paise || 0);
  const dates = subscriptionPeriodDates(billingCycle);
  const isFree = price === 0;
  await pool.query(
    'INSERT INTO merchant_subscriptions (id, merchant_id, plan_id, status, billing_cycle, plan_price_paise, payment_status, billing_reference, billing_note, renews_at, expires_at, grace_until) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    [id, merchantId, plan.id, isFree ? 'active' : status, billingCycle, price, isFree ? 'not_required' : paymentStatus, billingReference, billingNote, isFree ? null : dates.renewsAt, isFree ? null : dates.expiresAt, isFree ? null : dates.graceUntil],
  );
  const [rows] = await pool.query('SELECT * FROM merchant_subscriptions WHERE id = ?', [id]);
  return rows[0];
}

export function hashToken(token) {
  return sha256Hex(token);
}

export { randomUUID };
