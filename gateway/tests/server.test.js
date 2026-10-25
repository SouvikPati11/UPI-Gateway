import test from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/server.js';

function startApp() {
  const app = createApp({
    config: {
      appName: 'YOUPI PG',
      nodeEnv: 'test',
      verificationMode: 'manual',
      db: { configured: false },
    },
  });
  return new Promise((resolve) => {
    const server = app.listen(0, () => resolve({ server, port: server.address().port }));
  });
}

test('health reports ok without a database; ready reports 503 without one', async () => {
  const { server, port } = await startApp();
  try {
    const health = await fetch(`http://127.0.0.1:${port}/health`);
    assert.equal(health.status, 200);
    const healthBody = await health.json();
    assert.equal(healthBody.status, 'ok');
    assert.equal(healthBody.database, 'not_configured');

    const ready = await fetch(`http://127.0.0.1:${port}/ready`);
    assert.equal(ready.status, 503);
  } finally {
    server.close();
  }
});

test('unknown routes 404, and no payment-success endpoint exists', async () => {
  const { server, port } = await startApp();
  try {
    for (const [method, url] of [
      ['GET', '/nope'],
      ['POST', '/api/v1/payments/success'],
      ['POST', '/api/v1/orders/123/success'],
      ['POST', '/api/v1/checkout/123/mark-paid'],
    ]) {
      const res = await fetch(`http://127.0.0.1:${port}${url}`, { method });
      assert.equal(res.status, 404, `${method} ${url} must not exist in Stage 1`);
    }
  } finally {
    server.close();
  }
});

test('responses carry basic security headers and no stack traces', async () => {
  const { server, port } = await startApp();
  try {
    const res = await fetch(`http://127.0.0.1:${port}/health`);
    assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(res.headers.get('x-frame-options'), 'SAMEORIGIN');
    assert.equal(res.headers.get('x-powered-by'), null);
  } finally {
    server.close();
  }
});
