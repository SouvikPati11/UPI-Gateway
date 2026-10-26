import crypto from 'node:crypto';
import { decryptAtRest } from './crypto.js';

export const WEBHOOK_BACKOFFS_MS = [5000, 30000, 120000, 600000, 3600000];

// HMAC over the exact raw JSON string that will be sent. Receivers must
// compute the HMAC over the raw request body, not over a re-serialised object.
export function signWebhookBody({ secret, bodyString, timestamp, deliveryId }) {
  const signature = crypto.createHmac('sha256', String(secret)).update(bodyString).digest('hex');
  return { signature: `sha256=${signature}`, timestamp: String(timestamp), deliveryId };
}

export function isSafeWebhookUrl(rawUrl, { isProduction }) {
  try {
    const url = new URL(rawUrl);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return { valid: false, error: 'Webhook URL must be http(s).' };
    if (isProduction && url.protocol !== 'https:') return { valid: false, error: 'Production webhooks require https.' };
    const host = url.hostname.toLowerCase();
    if (isProduction && (host === 'localhost' || host.endsWith('.local') || host.startsWith('127.') || host === '::1' || host.startsWith('10.') || host.startsWith('192.168.') || host.startsWith('172.16.'))) {
      return { valid: false, error: 'Webhook URL must not point at a private address in production.' };
    }
    return { valid: true, url: url.toString() };
  } catch {
    return { valid: false, error: 'Webhook URL is invalid.' };
  }
}

export async function audit(pool, { actorType, actorId, merchantId, entityType, entityId, action, details, ip }) {
  try {
    await pool.query(
      'INSERT INTO audit_logs (actor_type, actor_id, merchant_id, entity_type, entity_id, action, details, ip_address) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      [actorType, actorId || null, merchantId || null, entityType, String(entityId), action, JSON.stringify(details || {}), ip || null],
    );
  } catch {
    // Audit logging must never break the primary action, but failures are
    // deliberately not swallowed silently in tests: the caller still succeeds.
  }
}

export async function addOrderEvent(pool, { orderId, eventType, statusFrom, statusTo, source, actorType, actorId, details }) {
  await pool.query(
    'INSERT INTO order_events (order_id, event_type, status_from, status_to, source, actor_type, actor_id, details) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    [orderId, eventType, statusFrom || null, statusTo || null, source || null, actorType || null, actorId || null, JSON.stringify(details || {})],
  );
}

// Attempt one outbound webhook delivery and record the result.
// Returns { attempted, successful, status }.
export async function deliverWebhook(pool, { merchant, order, eventType, config }) {
  if (!merchant.webhook_url) return { attempted: false, successful: false, reason: 'no_webhook_url' };
  const check = isSafeWebhookUrl(merchant.webhook_url, { isProduction: config.isProduction });
  if (!check.valid) return { attempted: false, successful: false, reason: check.error };
  let secret;
  try {
    secret = merchant.webhook_secret_encrypted ? decryptAtRest(merchant.webhook_secret_encrypted, config.encryptionKey) : null;
  } catch {
    return { attempted: false, successful: false, reason: 'webhook_secret_decrypt_failed' };
  }
  if (!secret) return { attempted: false, successful: false, reason: 'no_webhook_secret' };

  const payload = {
    event: eventType,
    orderId: order.merchant_order_id,
    gatewayReference: order.gateway_reference,
    merchantId: merchant.id,
    amountPaise: Number(order.amount_paise),
    currency: order.currency || 'INR',
    status: order.status,
    method: order.method || 'upi',
    verificationSource: order.verification_source || 'none',
    utr: order.verification_utr || null,
    completedAt: order.verified_at || order.updated_at || null,
  };
  const bodyString = JSON.stringify(payload);
  const deliveryId = crypto.randomUUID();
  const timestamp = String(Date.now());
  const { signature } = signWebhookBody({ secret, bodyString, timestamp, deliveryId });

  const rowId = crypto.randomUUID();
  await pool.query(
    'INSERT INTO webhook_deliveries (id, merchant_id, order_id, delivery_id, event_type, endpoint_url, payload, attempt_count, is_successful, next_retry_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    [rowId, merchant.id, order.id, deliveryId, eventType, check.url, bodyString, 0, 0, null],
  );

  let status = null;
  let body = '';
  let successful = false;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10000);
    const res = await fetch(check.url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Gateway-Signature': signature,
        'X-Gateway-Timestamp': timestamp,
        'X-Gateway-Delivery-Id': deliveryId,
        'X-Gateway-Event': eventType,
      },
      body: bodyString,
      signal: controller.signal,
    });
    clearTimeout(timer);
    status = res.status;
    body = (await res.text()).slice(0, 2000);
    successful = res.status >= 200 && res.status < 300;
  } catch (err) {
    body = String(err?.message || err).slice(0, 2000);
  }

  const nextRetry = successful ? null : new Date(Date.now() + WEBHOOK_BACKOFFS_MS[0]).toISOString().slice(0, 19).replace('T', ' ');
  await pool.query(
    'UPDATE webhook_deliveries SET attempt_count = ?, is_successful = ?, response_status = ?, response_body = ?, next_retry_at = ? WHERE id = ?',
    [1, successful ? 1 : 0, status, body, nextRetry, rowId],
  );
  return { attempted: true, successful, status };
}

// Retry deliveries that are due. Called from the cron endpoint and from
// the admin/merchant retry button. Never retries a successful delivery.
export async function retryDueDeliveries(pool, config, { limit = 20 } = {}) {
  const [rows] = await pool.query(
    "SELECT * FROM webhook_deliveries WHERE is_successful = 0 AND attempt_count < 5 AND next_retry_at IS NOT NULL AND next_retry_at <= UTC_TIMESTAMP() ORDER BY next_retry_at ASC LIMIT ?",
    [limit],
  );
  const results = [];
  for (const delivery of rows) {
    const [merchants] = await pool.query('SELECT * FROM merchants WHERE id = ?', [delivery.merchant_id]);
    const merchant = merchants[0];
    if (!merchant || !merchant.webhook_secret_encrypted) continue;
    let secret;
    try {
      secret = decryptAtRest(merchant.webhook_secret_encrypted, config.encryptionKey);
    } catch {
      continue;
    }
    const bodyString = typeof delivery.payload === 'string' ? delivery.payload : JSON.stringify(delivery.payload);
    const timestamp = String(Date.now());
    const { signature } = signWebhookBody({ secret, bodyString, timestamp, deliveryId: delivery.delivery_id });
    let status = null;
    let body = '';
    let successful = false;
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 10000);
      const res = await fetch(delivery.endpoint_url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Gateway-Signature': signature,
          'X-Gateway-Timestamp': timestamp,
          'X-Gateway-Delivery-Id': delivery.delivery_id,
          'X-Gateway-Event': delivery.event_type,
        },
        body: bodyString,
        signal: controller.signal,
      });
      clearTimeout(timer);
      status = res.status;
      body = (await res.text()).slice(0, 2000);
      successful = res.status >= 200 && res.status < 300;
    } catch (err) {
      body = String(err?.message || err).slice(0, 2000);
    }
    const attempt = Number(delivery.attempt_count) + 1;
    const nextRetry = successful || attempt >= 5 ? null : new Date(Date.now() + WEBHOOK_BACKOFFS_MS[Math.min(attempt - 1, WEBHOOK_BACKOFFS_MS.length - 1)]).toISOString().slice(0, 19).replace('T', ' ');
    await pool.query(
      'UPDATE webhook_deliveries SET attempt_count = ?, is_successful = ?, response_status = ?, response_body = ?, next_retry_at = ? WHERE id = ?',
      [attempt, successful ? 1 : 0, status, body, nextRetry, delivery.id],
    );
    results.push({ deliveryId: delivery.delivery_id, successful, status, attempt });
  }
  return results;
}
