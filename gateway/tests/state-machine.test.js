import test from 'node:test';
import assert from 'node:assert/strict';
import { isValidTransition, isTerminalStatus, assertValidTransition } from '../src/state-machine.js';

test('the only path to success goes through processing', () => {
  assert.equal(isValidTransition('pending', 'processing'), true);
  assert.equal(isValidTransition('processing', 'success'), true);
  // No shortcut: a fresh pending order cannot jump straight to success.
  assert.equal(isValidTransition('pending', 'success'), false);
});

test('success can only become a recorded refund, never go backwards', () => {
  assert.equal(isValidTransition('success', 'refunded'), true);
  assert.equal(isValidTransition('success', 'pending'), false);
  assert.equal(isValidTransition('success', 'processing'), false);
});

test('terminal states stay terminal (except the recorded-refund rule above)', () => {
  for (const status of ['failed', 'expired', 'cancelled', 'refunded']) {
    assert.equal(isTerminalStatus(status), true);
    assert.equal(isValidTransition(status, 'pending'), false);
    assert.equal(isValidTransition(status, 'success'), false);
  }
  assert.throws(() => assertValidTransition('failed', 'success'), /Illegal order state transition/);
});
