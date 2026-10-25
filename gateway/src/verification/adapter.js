// Verification adapter INTERFACE for v1 (Stage 1 foundation only).
// No route in Stage 1 calls this to mark an order successful, and no
// adapter implementation is wired up yet. This file exists so Stage 4
// has a single, auditable contract to implement, instead of scattering
// "is this paid?" logic across routes.
//
// Approved v1 sources (user decision, 2026-10-25):
//   - "manual":    an admin reconciles the order against a bank statement
//                  / official record in the admin panel (Stage 4).
//   - "observer":  an OPTIONAL external observer service (Android SMS app
//                  or Gmail ingester running OUTSIDE the cPanel app) posts
//                  a signed observation. The gateway must still validate
//                  merchant, amount, UTR, duplicate fingerprint and order
//                  status before any transition.
//   - "provider":  a real bank / payment-provider API or webhook. This is
//                  an interface slot only. It must NOT be claimed as
//                  working, and must NOT auto-succeed anything, until a
//                  real provider integration is configured and tested.
//
// Never accepted as proof, in any adapter:
//   QR scan, customer redirect, screenshot, or a customer "I have paid"
//   button / confirmation. Those are UI events, not settlement evidence.

export const VERIFICATION_SOURCES = Object.freeze(['manual', 'observer', 'provider', 'sandbox']);
export const UTR_RE = /^[0-9]{12}$/;

export function validateVerificationEvent(event) {
  const errors = [];
  if (!event || typeof event !== 'object') return ['Verification event must be an object.'];
  if (!VERIFICATION_SOURCES.includes(event.source)) {
    errors.push(`source must be one of: ${VERIFICATION_SOURCES.join(', ')}.`);
  }
  // Sandbox events are test-only and must never be accepted in production.
  // The production guard lives in the Stage 4 route; the rule is stated
  // here so the interface itself documents it.
  if (!event.merchantId) errors.push('merchantId is required.');
  if (!event.orderId) errors.push('orderId is required.');
  if (!Number.isInteger(event.amountPaise) || event.amountPaise <= 0) {
    errors.push('amountPaise must be a positive integer (paise).');
  }
  if (event.utr !== undefined && event.utr !== null && !UTR_RE.test(String(event.utr))) {
    errors.push('utr, when present, must be a 12-digit bank reference.');
  }
  if (!event.fingerprintHash || typeof event.fingerprintHash !== 'string') {
    errors.push('fingerprintHash is required for duplicate-event detection.');
  }
  return errors;
}

// Interface that a Stage 4 adapter must implement. Returning this shape
// does not by itself change an order; the Stage 4 route must still check
// the order's current status, the merchant match, the exact amount and
// the fingerprint against verification_events before transitioning.
export class VerificationAdapter {
  constructor(source) {
    if (!VERIFICATION_SOURCES.includes(source)) throw new Error(`Unknown verification source: ${source}`);
    this.source = source;
  }
  async verify(_event) {
    throw new Error('VerificationAdapter.verify() is not implemented in Stage 1.');
  }
}
