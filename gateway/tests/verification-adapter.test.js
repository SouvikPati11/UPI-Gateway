import test from 'node:test';
import assert from 'node:assert/strict';
import { validateVerificationEvent, VerificationAdapter } from '../src/verification/adapter.js';

const VALID = {
  source: 'manual',
  merchantId: '00000000-0000-0000-0000-000000000001',
  orderId: '00000000-0000-0000-0000-000000000002',
  amountPaise: 49900,
  utr: '123456789012',
  fingerprintHash: 'a'.repeat(64),
};

test('a well-formed manual verification event passes validation', () => {
  assert.deepEqual(validateVerificationEvent(VALID), []);
});

test('verification rejects wrong amounts, bad UTRs and missing fingerprints', () => {
  assert.ok(validateVerificationEvent({ ...VALID, amountPaise: 0 }).length > 0);
  assert.ok(validateVerificationEvent({ ...VALID, amountPaise: 499.5 }).length > 0);
  assert.ok(validateVerificationEvent({ ...VALID, utr: '123' }).length > 0);
  assert.ok(validateVerificationEvent({ ...VALID, fingerprintHash: '' }).length > 0);
  assert.ok(validateVerificationEvent({ ...VALID, merchantId: '' }).length > 0);
});

test('no adapter implementation exists yet in Stage 1 — verify() must throw', async () => {
  const adapter = new VerificationAdapter('manual');
  await assert.rejects(() => adapter.verify(VALID), /not implemented in Stage 1/);
  assert.throws(() => new VerificationAdapter('qr-scan'), /Unknown verification source/);
});
