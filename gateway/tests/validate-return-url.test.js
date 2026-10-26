import test from 'node:test';
import assert from 'node:assert/strict';
import { validateReturnUrl } from '../src/validate.js';

test('validateReturnUrl accepts http and https, rejects other schemes and garbage', () => {
  assert.equal(validateReturnUrl(''), '');
  assert.equal(validateReturnUrl(undefined), '');
  assert.equal(validateReturnUrl(null), '');
  assert.equal(validateReturnUrl('https://merchant.example.test/thank-you'), 'https://merchant.example.test/thank-you');
  assert.equal(validateReturnUrl('http://127.0.0.1:3000/return'), 'http://127.0.0.1:3000/return');
  assert.equal(validateReturnUrl('  https://example.test/  '), 'https://example.test/');
  assert.equal(validateReturnUrl('javascript:alert(1)'), null);
  assert.equal(validateReturnUrl('data:text/html,<script>alert(1)</script>'), null);
  assert.equal(validateReturnUrl('ftp://example.test/file'), null);
  assert.equal(validateReturnUrl('not a url'), null);
  assert.equal(validateReturnUrl(123), null);
});
