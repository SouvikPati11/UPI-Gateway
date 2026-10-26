import test from 'node:test';
import assert from 'node:assert/strict';
import { validateConfig } from '../src/config.js';

const VALID_PROD = {
  NODE_ENV: 'production',
  APP_BASE_URL: 'https://pay.example-merchant.in',
  DB_HOST: 'localhost',
  DB_PORT: '3306',
  DB_USER: 'gateway_user',
  DB_PASSWORD: 'a-real-password-from-cpanel',
  DB_NAME: 'gateway_db',
  SESSION_SECRET: 'a'.repeat(40),
  ENCRYPTION_MASTER_KEY: 'b'.repeat(64),
  VERIFICATION_MODE: 'manual',
};

test('production config passes with real-looking values', () => {
  const { errors, config } = validateConfig({ ...VALID_PROD });
  assert.deepEqual(errors, []);
  assert.equal(config.isProduction, true);
  assert.equal(config.db.configured, true);
});

test('production config rejects the .env.example placeholders', () => {
  const { errors } = validateConfig({
    ...VALID_PROD,
    SESSION_SECRET: 'change-me-session-secret-at-least-32-chars',
    ENCRYPTION_MASTER_KEY: 'REPLACE_WITH_64_HEX_CHARS_GENERATED_BY_crypto_randomBytes_32',
    APP_BASE_URL: 'https://example.com',
    DB_PASSWORD: 'change-me-db-password',
  });
  assert.ok(errors.some((e) => e.includes('SESSION_SECRET')));
  assert.ok(errors.some((e) => e.includes('ENCRYPTION_MASTER_KEY')));
  assert.ok(errors.some((e) => e.includes('APP_BASE_URL')));
  assert.ok(errors.some((e) => e.includes('DB_PASSWORD')));
});

test('production config rejects a short session secret and non-hex encryption key', () => {
  const { errors } = validateConfig({ ...VALID_PROD, SESSION_SECRET: 'short', ENCRYPTION_MASTER_KEY: 'not-hex' });
  assert.ok(errors.some((e) => e.includes('SESSION_SECRET')));
  assert.ok(errors.some((e) => e.includes('ENCRYPTION_MASTER_KEY')));
});

test('production config rejects a missing database', () => {
  const env = { ...VALID_PROD };
  delete env.DB_HOST;
  delete env.DB_NAME;
  const { errors } = validateConfig(env);
  assert.ok(errors.some((e) => e.includes('DB_HOST')));
  assert.ok(errors.some((e) => e.includes('DB_NAME')));
});

test('production config rejects an unknown verification mode', () => {
  const { errors } = validateConfig({ ...VALID_PROD, VERIFICATION_MODE: 'auto-magic' });
  assert.ok(errors.some((e) => e.includes('VERIFICATION_MODE')));
});
