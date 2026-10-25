import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { listMigrationFiles, splitStatements } from '../src/db/migrate.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const migrationsDir = path.resolve(__dirname, '../migrations');

test('migration 001 exists and creates the required Stage 1 tables', () => {
  const files = listMigrationFiles(migrationsDir);
  assert.deepEqual(files, ['001_init.sql', '002_order_mode_expiry.sql', '003_order_seq.sql']);
  const sql002 = fs.readFileSync(path.join(migrationsDir, '002_order_mode_expiry.sql'), 'utf8');
  assert.ok(sql002.includes('ADD COLUMN mode'));
  assert.ok(sql002.includes('ADD COLUMN expires_at'));
  assert.ok(sql002.includes('ADD COLUMN idempotency_key'));
  const sql = fs.readFileSync(path.join(migrationsDir, files[0]), 'utf8');
  for (const table of [
    'admins', 'merchants', 'receiving_accounts', 'merchant_api_keys', 'sessions',
    'orders', 'order_events', 'verification_events', 'webhook_deliveries',
    'audit_logs', 'app_settings',
  ]) {
    assert.ok(new RegExp(`CREATE TABLE IF NOT EXISTS ${table} \\(`).test(sql), `missing table ${table}`);
  }
  // Merchant auth foundations must exist (the original schema lacked them).
  assert.ok(sql.includes('password_hash'));
  assert.ok(sql.includes("status VARCHAR(20) NOT NULL DEFAULT 'pending'"));
  assert.ok(sql.includes('key_hash'));
  assert.ok(sql.includes('fingerprint_hash CHAR(64) NOT NULL UNIQUE'));
  // No seeded admin / merchant / secret: the Stage 6 installer creates them.
  assert.ok(!/INSERT INTO (admins|merchants)/.test(sql));
});

test('migration SQL is MySQL/MariaDB style, not PostgreSQL style', () => {
  const sql = fs.readFileSync(path.join(migrationsDir, '001_init.sql'), 'utf8');
  assert.ok(!sql.includes('TIMESTAMPTZ'), 'PostgreSQL TIMESTAMPTZ must not appear');
  assert.ok(!sql.includes('uuid-ossp'), 'PostgreSQL extension must not appear');
  assert.ok(!sql.includes('CREATE EXTENSION'), 'PostgreSQL extension must not appear');
  assert.ok(sql.includes('ENGINE=InnoDB'));
  assert.ok(sql.includes('amount_paise BIGINT'));
});

test('migration statements split cleanly for the runner', () => {
  const sql = fs.readFileSync(path.join(migrationsDir, '001_init.sql'), 'utf8');
  const stmts = splitStatements(sql);
  assert.ok(stmts.length >= 11, `expected at least 11 statements, got ${stmts.length}`);
  assert.ok(stmts.every((s) => s.startsWith('CREATE TABLE')));
});

test('.env.example contains placeholders only, no real secret', () => {
  const example = fs.readFileSync(path.resolve(__dirname, '../.env.example'), 'utf8');
  assert.ok(example.includes('change-me'));
  assert.ok(example.includes('REPLACE_WITH'));
  assert.ok(example.includes('example.com'));
  // The example must not look like a production secret.
  assert.ok(!/^[A-Fa-f0-9]{64}$/m.test(example.replace('REPLACE_WITH_64_HEX_CHARS_GENERATED_BY_crypto_randomBytes_32', '')));
});
