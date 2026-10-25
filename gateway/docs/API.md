# YOUPI PG — Merchant API, SDK and Webhook Documentation

Base URL: the URL of your installed gateway, for example `https://gateway.example.com`.
All API examples use that base URL. Replace it with your own installation.

## Authentication

Create API keys in the merchant dashboard under **API keys**.

- **Secret keys** (`sk_...`) are for server-side API calls only. Send one as
  `Authorization: Bearer sk_...` or as `X-Api-Key: sk_...`. Never put a
  secret key in browser JavaScript, HTML, a mobile app, or a public repo.
- **Public keys** (`pk_...`) are publishable and identify a merchant in the
  browser. They cannot create orders. The API rejects a public key for order
  creation with `401`.
- Secret keys are stored only as a prefix + SHA-256 hash. The full secret is
  shown exactly once at creation. Rotate a key to create a new one and revoke
  the old one; revocation is immediate.
- API keys work only for an **approved** merchant. Pending or suspended
  merchants get `403` for order creation.

## Create an order

`POST /api/v1/orders`

Headers: `Authorization: Bearer sk_YOUR_SECRET_KEY`, `Content-Type: application/json`

Body (JSON):

```json
{
  "merchant_order_id": "ORDER-1001",
  "amount_paise": 49900,
  "currency": "INR",
  "mode": "live",
  "customer_name": "Test Customer",
  "customer_email": "customer@example.com",
  "customer_phone": "9876543210",
  "return_url": "https://yourstore.example/order-done",
  "idempotency_key": "optional-unique-key",
  "metadata": { "cart_id": "abc" }
}
```

- `amount_paise` is an integer number of paise (49900 = ₹499.00). You may
  pass `amount` as a string instead, for example `"499.00"`; it is parsed
  without floating point.
- `mode` is `live` (default) or `sandbox`. Sandbox orders are test orders
  only, clearly labelled TEST on checkout, and use a synthetic reference.
- `merchant_order_id` must be unique per merchant. A duplicate returns `409`
  with the existing `gateway_reference`, unless `idempotency_key` matches an
  existing order, in which case the existing order is returned (`idempotent: true`).
- `currency` is INR only. Any other currency returns `400` and no order is
  created; a non-INR value is never silently treated as INR.
- `return_url`, when given, must be a valid `http://` or `https://` URL.
  Other schemes (for example `javascript:`) return `400`.
- Orders expire after 15 minutes if not paid and verified. Expiry is checked
  on checkout load and by the cron endpoint.

## Create an order from the merchant dashboard (no API code needed)

An approved merchant can also create a payment link in the dashboard:
**Orders → New order**. The form asks for the amount in rupees, an optional
merchant order ID (auto-generated when blank), customer details, an optional
return URL and live/sandbox mode. The created order is the same pending
order the API creates, with the same checkout QR code and deep link.
Pending or suspended merchants cannot create dashboard orders either.

## Record a refund (admin only)

There is no public API refund endpoint. An administrator records a refund
from an order's admin detail page, only for a `success` order. This records
the refund in the gateway, adds an `order_refunded` event and sends a
`REFUNDED` webhook to the merchant. It does not automatically move money
back at the bank — the actual bank refund must be recorded separately
before using this button.

Success response (`201`):

```json
{
  "order": {
    "gateway_reference": "YP20261025XXXXXXXXXX",
    "merchant_order_id": "ORDER-1001",
    "merchant": "Acme Test Store",
    "amount_paise": 49900,
    "amount": "₹499.00",
    "currency": "INR",
    "status": "pending",
    "mode": "live",
    "verification_source": "none",
    "checkout_url": "https://gateway.example.com/checkout/YP20261025XXXXXXXXXX",
    "expires_at": "2026-10-25 12:30:00",
    "created_at": "2026-10-25 12:15:00"
  },
  "idempotent": false
}
```

## Get an order (merchant-scoped)

`GET /api/v1/orders/:gateway_reference` — same secret-key authentication.
A merchant can only read their own orders; another merchant's reference
returns `404`, not the order.

## Public order status (for checkout polling)

`GET /api/public/orders/:gateway_reference/status` — no authentication.
Returns only the reference, status, amount, verification source, mode and
return URL. It never returns merchant secrets, UPI credentials or keys.

## Checkout

Redirect the customer to `checkout_url`, or open it with the SDK:

```html
<script src="https://gateway.example.com/public/sdk.js"></script>
<script>
  // checkoutUrl comes from YOUR server, which created the order with a secret key.
  YoupiCheckout.open(checkoutUrl);
</script>
```

Or use a declarative button:

```html
<button data-youpi-checkout-url="https://gateway.example.com/checkout/YP...">Pay</button>
```

The checkout page shows:

- the merchant name, UPI ID and exact amount;
- a dynamic QR code generated from the merchant's UPI ID and order amount;
- a UPI deep link (`upi://pay?pa=...&pn=...&am=...&cu=INR&tn=...`) that
  opens GPay, PhonePe, Paytm, BHIM, CRED or another UPI app on mobile;
- a live status poll (every 5 seconds) against the public status endpoint;
- an **"I have paid"** button that moves the order to `processing` for
  verification — it does **not** mark the order successful;
- for sandbox orders only, a **sandbox simulator** button that creates a
  clearly-labelled TEST success with a synthetic reference.

### FIFO queue

Only one order per merchant UPI ID shows a QR code at a time. Later orders
show a queue page with their position and refresh automatically. This
matches bank alerts to the correct order. A queued order is promoted when
the earlier order reaches a terminal state or expires (15 minutes).

## Order states

`pending` → `processing` → `success` | `failed` | `expired` | `cancelled`
`success` → `refunded` (recorded/manual refund only, never an automatic reversal)

There is **no** `pending → success` shortcut in code. Every path to success
goes through `processing` (customer click, manual reconciliation, observer,
provider, or sandbox simulator), with an `order_events` row for each step.

## Payment verification (read this before going live)

A QR scan, a UPI app opening, a redirect, a screenshot, or an
"I have paid" click is **never** proof of payment. Orders stay pending
until verified by one of these sources, shown on every order as
`verification_source`:

1. **Manual reconciliation (default, always available).** An administrator
   compares the order against the merchant's official bank record in
   **Admin → Verification queue**, enters the 12-digit UTR, and marks the
   order successful. Duplicate UTRs for the same merchant are rejected.
   This is the only verification source that works with no external service.
2. **Optional external observer.** Set `OBSERVER_API_TOKEN` and send events
   to `POST /api/v1/observers/events` with header `X-Observer-Token`.
   Events are validated (merchant, amount, fingerprint, order status) and
   deduplicated by `fingerprint_hash`; a duplicate fingerprint returns
   `{"received": true, "duplicate": true}` and is not applied twice.
   An observer that cannot match an order is stored as `unattributed` for
   the admin queue, not silently applied. The Android SMS and Gmail
   observers from the original project are **optional** and are not
   required for the core gateway; they are not bundled as mandatory services.
3. **Provider API / webhook (only when configured and tested).**
   Set `PROVIDER_WEBHOOK_SECRET` and send signed webhooks to
   `POST /api/v1/provider/webhook` with headers `X-Provider-Signature`
   (`sha256=<hex>` over the raw body), `X-Provider-Timestamp` (within
   5 minutes) and `X-Provider-Delivery-Id` (idempotency key).
   If the secret is not set, the endpoint returns `501 provider_not_configured`.
   **No provider integration is included by default.** A real provider
   requires a contract, credentials and testing with that provider; do not
   enable provider mode until that is done.
4. **Sandbox simulator (test orders only).** Only for `mode: "sandbox"`
   orders, on the checkout page. It creates a TEST success with the
   synthetic reference `SANDBOX000001` and `verification_source: "sandbox"`.
   It is blocked with `403` for live orders, and sandbox orders are rejected
   in the manual verification queue.

If no reliable verification source is available, keep the payment pending
until it is verified. Do not fabricate UTRs, bank confirmations or success
events. This gateway never collects UPI PINs, banking passwords or banking
authentication secrets.

## Webhooks (outbound, merchant-facing)

When an order reaches a terminal state (`SUCCESS`, `FAILED`, `EXPIRED`,
`CANCELLED`, `REFUNDED`), the gateway POSTs to the merchant's configured
webhook URL with:

Headers:

```
Content-Type: application/json
X-Gateway-Signature: sha256=<hex>
X-Gateway-Timestamp: <milliseconds since epoch>
X-Gateway-Delivery-Id: <uuid>
X-Gateway-Event: SUCCESS
```

Body (JSON):

```json
{
  "event": "SUCCESS",
  "orderId": "ORDER-1001",
  "gatewayReference": "YP20261025XXXXXXXXXX",
  "merchantId": "<merchant uuid>",
  "amountPaise": 49900,
  "currency": "INR",
  "status": "success",
  "method": "upi",
  "verificationSource": "manual",
  "utr": "123456789012",
  "completedAt": "2026-10-25 12:20:00"
}
```

### Verifying a webhook (required)

Compute HMAC-SHA256 over the **raw request body** (not a re-serialised
object) with your webhook secret, compare it in constant time with
`X-Gateway-Signature`, check the timestamp is recent (within 5 minutes),
and process each `X-Gateway-Delivery-Id` only once.

Node.js (Express — use `express.raw` for this route):

```js
const expected = 'sha256=' + crypto.createHmac('sha256', webhookSecret).update(req.body).digest('hex');
if (!crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) return res.status(401).end();
```

PHP:

```php
$expected = 'sha256=' . hash_hmac('sha256', $rawBody, $webhookSecret);
if (!hash_equals($expected, $signature)) { http_response_code(401); exit; }
```

Python:

```python
expected = 'sha256=' + hmac.new(webhook_secret.encode(), raw_body, hashlib.sha256).hexdigest()
if not hmac.compare_digest(expected, signature):
    return 401
```

Deliveries are logged in **Merchant → Webhooks** and **Admin → Webhooks**
with attempt count, response status and next retry time. Retries use
backoff 5s, 30s, 2m, 10m, 1h (maximum 5 attempts). A merchant can retry a
failed delivery from the dashboard; a cron job can retry due deliveries:

```
POST /cron/webhooks   (header X-Cron-Secret: <CRON_SECRET>)
POST /cron/expire     (expires overdue pending/processing orders)
```

If `CRON_SECRET` is not set, cron endpoints return `503` (disabled).

## Rate limits and errors

- API: 120 requests per minute per IP (per route).
- Login: 30 attempts per 15 minutes per IP (per route).
- `429` means slow down and retry later.
- Errors never include stack traces or secrets. A `500` response is a
  generic `{"error": "Internal error"}`; details are in the server log.

## Sandbox testing checklist

1. Create a merchant, approve it in the admin panel.
2. Create a secret API key, then an order with `"mode": "sandbox"`.
3. Open the checkout URL: it must show a TEST banner and a sandbox button.
4. Click the sandbox button: status becomes `success` with
   `verification_source: "sandbox"`.
5. Create a live order and confirm the sandbox button is blocked (`403`).
6. Confirm a live order is not marked successful by "I have paid" alone.
