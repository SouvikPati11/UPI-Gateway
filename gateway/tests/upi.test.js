import test from 'node:test';
import assert from 'node:assert/strict';
import { buildUpiUri, formatPaiseAsRupees } from '../src/upi.js';

test('49900 paise formats as 499.00 without floating point', () => {
  assert.equal(formatPaiseAsRupees(49900), '499.00');
  assert.equal(formatPaiseAsRupees(5), '0.05');
  assert.equal(formatPaiseAsRupees(100), '1.00');
});

test('builds a UPI URI from the merchant VPA and order amount', () => {
  const uri = buildUpiUri({ upiId: 'shop@okhdfc', payeeName: 'Acme Store', amountPaise: 49900, transactionRef: 'ORD-1001' });
  assert.ok(uri.startsWith('upi://pay?'));
  const params = new URLSearchParams(uri.slice('upi://pay?'.length));
  assert.equal(params.get('pa'), 'shop@okhdfc');
  assert.equal(params.get('pn'), 'Acme Store');
  assert.equal(params.get('am'), '499.00');
  assert.equal(params.get('cu'), 'INR');
  assert.equal(params.get('tn'), 'ORD-1001');
});

test('rejects invalid UPI IDs, zero amounts and missing references', () => {
  assert.throws(() => buildUpiUri({ upiId: 'not-a-vpa', payeeName: 'X', amountPaise: 100, transactionRef: 'R1' }), /upiId/);
  assert.throws(() => buildUpiUri({ upiId: 'shop@okhdfc', payeeName: 'X', amountPaise: 0, transactionRef: 'R1' }), /greater than 0/);
  assert.throws(() => buildUpiUri({ upiId: 'shop@okhdfc', payeeName: 'X', amountPaise: 100, transactionRef: '' }), /transactionRef/);
});
