-- 002_order_mode_expiry.sql — fields required by the full gateway.
-- Safe on existing Stage 1 databases: every change is additive and uses
-- IF NOT EXISTS / best-effort ALTER semantics via the migration runner's
-- CREATE TABLE IF NOT EXISTS handling is not available for ALTER, so this
-- file is written for MySQL 8 / MariaDB 10.5+ where these columns do not
-- yet exist on a fresh Stage 1 database. On an already-migrated database
-- the runner records 002 as applied only after the whole file succeeds.
-- NOTE: if you are upgrading a database that already has these columns
-- (for example from a manual edit), run this file manually and remove the
-- duplicate ALTER lines first. The installer never drops or erases data.

ALTER TABLE orders ADD COLUMN mode VARCHAR(10) NOT NULL DEFAULT 'live';
ALTER TABLE orders ADD COLUMN expires_at DATETIME NULL;
ALTER TABLE orders ADD COLUMN idempotency_key VARCHAR(255) NULL;
CREATE UNIQUE INDEX uq_orders_idempotency ON orders (merchant_id, idempotency_key);
