# Verification for v1 — manual reconciliation + optional external observers

**Decision (user-approved, 2026-10-25):** v1 uses manual reconciliation and a
clearly documented optional external-observer interface. A provider
API/webhook adapter interface exists (`src/verification/adapter.js`) but is
**not implemented and not wired to any route in Stage 1**.

## What is never proof of payment

A QR scan, a customer redirect back to the merchant, a screenshot, or a
customer pressing "I have paid" / confirming payment is **never** proof of
payment and must never transition an order to `success`. Stage 1 contains no
endpoint that could do this, by design.

## The three v1 paths (Stage 4 will implement them; Stage 1 only defines them)

1. **Manual reconciliation (default, `VERIFICATION_MODE=manual`).**
   An admin compares the order (merchant, exact amount in paise, gateway
   reference) against the merchant's official bank record, then records the
   outcome in the admin panel with the UTR and the evidence reference.
   The order moves `pending -> processing -> success` only through that
   recorded, audited action, with a row in `order_events` and `audit_logs`.
   Wrong amount, wrong merchant, expired order or duplicate evidence must
   not succeed the order.

2. **Optional external observer (`VERIFICATION_MODE=observer`).**
   An observer service (for example the existing Android SMS app, or a Gmail
   ingester) runs **outside** the cPanel app, on its own device/server, and
   posts a signed observation to the gateway. The gateway must still
   validate, before any transition: merchant match, exact amount in paise,
   UTR format (12 digits when present), order not already terminal, and
   `fingerprint_hash` not already seen in `verification_events`
   (duplicate-event idempotency). An observer alert on its own, without
   those checks, is not settlement proof — it is an observation that must
   be matched and, for ambiguous cases, held for manual review.

3. **Provider API / webhook (`VERIFICATION_MODE=provider`) — interface only.**
   Until a real bank or payment-provider integration is configured **and
   tested** against that provider's sandbox and webhook signatures, this
   mode must not be enabled and no automatic bank verification may be
   claimed. When it is implemented (Stage 4+), it must validate the
   provider signature over the raw body, the timestamp window, the delivery
   idempotency key, the merchant, the exact amount and the order status,
   exactly as the original webhook engine did for merchant webhooks.

## Refunds

`refunded` in the order state machine means a refund was **recorded**
(manual bank transfer / provider refund, with evidence). A UPI peer-to-peer
payment has no automatic reversal, and this gateway must never present a
recorded refund as an automatic bank reversal unless a provider refund API
is actually configured and tested.
