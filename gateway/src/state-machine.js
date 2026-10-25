// Order state graph for the new MySQL gateway (Stage 1 foundation).
// This is a pure transition table — it is NOT a payment-success endpoint.
// There is deliberately no transition that a browser, QR scan, redirect,
// screenshot or customer confirmation can trigger on its own.
//
// Flow: pending -> processing -> success -> refunded (recorded only)
//       pending/processing -> failed | expired | cancelled
// A UPI P2P payment has no automatic bank reversal, so "refunded" here
// means "a refund was recorded / made manually" (Stage 4), never an
// automatic reversal, unless a real provider refund API is configured.

export const ORDER_STATUSES = Object.freeze([
  'pending',
  'processing',
  'success',
  'failed',
  'expired',
  'cancelled',
  'refunded',
]);

const TRANSITIONS = Object.freeze({
  pending: ['processing', 'failed', 'expired', 'cancelled'],
  processing: ['success', 'failed', 'expired', 'cancelled'],
  success: ['refunded'],
  failed: [],
  expired: [],
  cancelled: [],
  refunded: [],
});

export function isValidTransition(from, to) {
  if (!ORDER_STATUSES.includes(from) || !ORDER_STATUSES.includes(to)) return false;
  return TRANSITIONS[from].includes(to);
}

export function isTerminalStatus(status) {
  return ['success', 'failed', 'expired', 'cancelled', 'refunded'].includes(status);
}

export function assertValidTransition(from, to) {
  if (!isValidTransition(from, to)) {
    throw new Error(`Illegal order state transition: ${from} -> ${to}.`);
  }
}
