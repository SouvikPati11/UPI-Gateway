-- 001_init.sql — Stage 1 foundations for the cPanel MySQL gateway.
-- MySQL 8.0+ / MariaDB 10.5+ compatible. InnoDB, utf8mb4.
-- All timestamps are DATETIME in UTC; the application must write UTC.
-- Money is integer paise (BIGINT). Never store rupees as FLOAT/DOUBLE.
-- Secrets: only HASHES are stored for secret API keys and session tokens.
-- A webhook secret must be recoverable to sign outbound webhooks, so it is
-- stored ENCRYPTED (webhook_secret_encrypted), never in plaintext, and the
-- encryption key lives only in ENCRYPTION_MASTER_KEY (env, never in git).
-- This migration creates tables only. No admin, merchant or key is seeded:
-- the first admin is created by the Stage 6 installer, not by SQL.

CREATE TABLE IF NOT EXISTS admins (
  id CHAR(36) NOT NULL PRIMARY KEY,
  email VARCHAR(255) NOT NULL UNIQUE,
  password_hash VARCHAR(255) NOT NULL,
  name VARCHAR(255) NOT NULL,
  role VARCHAR(20) NOT NULL DEFAULT 'admin',
  status VARCHAR(20) NOT NULL DEFAULT 'active',
  last_login_at DATETIME NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT chk_admins_status CHECK (status IN ('active', 'suspended'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS merchants (
  id CHAR(36) NOT NULL PRIMARY KEY,
  business_name VARCHAR(255) NOT NULL,
  slug VARCHAR(100) NOT NULL UNIQUE,
  contact_email VARCHAR(255) NOT NULL,
  contact_phone VARCHAR(20) NULL,
  password_hash VARCHAR(255) NOT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'pending',
  upi_id VARCHAR(255) NULL,
  payee_name VARCHAR(255) NULL,
  webhook_url VARCHAR(1024) NULL,
  webhook_secret_encrypted TEXT NULL,
  branding JSON NULL,
  approved_at DATETIME NULL,
  suspended_at DATETIME NULL,
  suspension_reason TEXT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT chk_merchants_status CHECK (status IN ('pending', 'approved', 'suspended'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS receiving_accounts (
  id CHAR(36) NOT NULL PRIMARY KEY,
  merchant_id CHAR(36) NOT NULL,
  upi_id VARCHAR(255) NOT NULL,
  payee_name VARCHAR(255) NOT NULL,
  is_active TINYINT(1) NOT NULL DEFAULT 1,
  is_slot_busy TINYINT(1) NOT NULL DEFAULT 0,
  current_order_id CHAR(36) NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT fk_receiving_merchant FOREIGN KEY (merchant_id) REFERENCES merchants (id) ON DELETE CASCADE,
  INDEX idx_receiving_merchant (merchant_id, is_active)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS merchant_api_keys (
  id CHAR(36) NOT NULL PRIMARY KEY,
  merchant_id CHAR(36) NOT NULL,
  key_prefix VARCHAR(16) NOT NULL,
  key_hash CHAR(64) NOT NULL,
  key_type VARCHAR(10) NOT NULL DEFAULT 'secret',
  public_value VARCHAR(255) NULL,
  name VARCHAR(100) NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'active',
  last_used_at DATETIME NULL,
  expires_at DATETIME NULL,
  revoked_at DATETIME NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_apikey_merchant FOREIGN KEY (merchant_id) REFERENCES merchants (id) ON DELETE CASCADE,
  CONSTRAINT chk_apikey_type CHECK (key_type IN ('public', 'secret')),
  CONSTRAINT chk_apikey_status CHECK (status IN ('active', 'revoked')),
  INDEX idx_apikey_merchant (merchant_id, status),
  INDEX idx_apikey_prefix (key_prefix)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS sessions (
  id CHAR(36) NOT NULL PRIMARY KEY,
  actor_type VARCHAR(20) NOT NULL,
  actor_id CHAR(36) NOT NULL,
  token_hash CHAR(64) NOT NULL UNIQUE,
  ip_address VARCHAR(45) NULL,
  user_agent TEXT NULL,
  expires_at DATETIME NOT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT chk_sessions_actor CHECK (actor_type IN ('merchant', 'admin')),
  INDEX idx_sessions_actor (actor_type, actor_id, expires_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS orders (
  id CHAR(36) NOT NULL PRIMARY KEY,
  merchant_id CHAR(36) NOT NULL,
  merchant_order_id VARCHAR(255) NOT NULL,
  gateway_reference VARCHAR(100) NOT NULL UNIQUE,
  receiving_account_id CHAR(36) NULL,
  amount_paise BIGINT NOT NULL,
  currency CHAR(3) NOT NULL DEFAULT 'INR',
  status VARCHAR(20) NOT NULL DEFAULT 'pending',
  method VARCHAR(20) NOT NULL DEFAULT 'upi',
  upi_id_used VARCHAR(255) NULL,
  customer_name VARCHAR(255) NULL,
  customer_email VARCHAR(255) NULL,
  customer_phone VARCHAR(20) NULL,
  return_url VARCHAR(1024) NULL,
  metadata JSON NULL,
  verification_source VARCHAR(20) NOT NULL DEFAULT 'none',
  verification_utr VARCHAR(20) NULL,
  verified_at DATETIME NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT fk_orders_merchant FOREIGN KEY (merchant_id) REFERENCES merchants (id) ON DELETE CASCADE,
  CONSTRAINT fk_orders_receiving FOREIGN KEY (receiving_account_id) REFERENCES receiving_accounts (id) ON DELETE SET NULL,
  CONSTRAINT chk_orders_amount CHECK (amount_paise > 0),
  CONSTRAINT chk_orders_status CHECK (status IN ('pending', 'processing', 'success', 'failed', 'expired', 'cancelled', 'refunded')),
  CONSTRAINT chk_orders_verification CHECK (verification_source IN ('none', 'manual', 'observer', 'provider', 'sandbox')),
  UNIQUE KEY uq_orders_merchant_order (merchant_id, merchant_order_id),
  INDEX idx_orders_merchant_status (merchant_id, status, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS order_events (
  id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  order_id CHAR(36) NOT NULL,
  event_type VARCHAR(100) NOT NULL,
  status_from VARCHAR(20) NULL,
  status_to VARCHAR(20) NULL,
  source VARCHAR(20) NULL,
  actor_type VARCHAR(20) NULL,
  actor_id VARCHAR(255) NULL,
  details JSON NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_events_order FOREIGN KEY (order_id) REFERENCES orders (id) ON DELETE CASCADE,
  INDEX idx_events_order (order_id, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS verification_events (
  id CHAR(36) NOT NULL PRIMARY KEY,
  merchant_id CHAR(36) NOT NULL,
  order_id CHAR(36) NULL,
  source VARCHAR(20) NOT NULL,
  amount_paise BIGINT NOT NULL,
  external_reference VARCHAR(255) NULL,
  fingerprint_hash CHAR(64) NOT NULL UNIQUE,
  raw_payload JSON NULL,
  attribution_status VARCHAR(20) NOT NULL DEFAULT 'unattributed',
  attributed_order_id CHAR(36) NULL,
  received_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_verif_merchant FOREIGN KEY (merchant_id) REFERENCES merchants (id) ON DELETE CASCADE,
  CONSTRAINT fk_verif_order FOREIGN KEY (order_id) REFERENCES orders (id) ON DELETE SET NULL,
  INDEX idx_verif_merchant_amount (merchant_id, amount_paise, attribution_status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS webhook_deliveries (
  id CHAR(36) NOT NULL PRIMARY KEY,
  merchant_id CHAR(36) NOT NULL,
  order_id CHAR(36) NULL,
  delivery_id CHAR(36) NOT NULL UNIQUE,
  event_type VARCHAR(50) NOT NULL,
  endpoint_url VARCHAR(1024) NOT NULL,
  payload JSON NOT NULL,
  response_status INT NULL,
  response_body TEXT NULL,
  attempt_count INT NOT NULL DEFAULT 0,
  is_successful TINYINT(1) NOT NULL DEFAULT 0,
  next_retry_at DATETIME NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT fk_webhook_merchant FOREIGN KEY (merchant_id) REFERENCES merchants (id) ON DELETE CASCADE,
  CONSTRAINT fk_webhook_order FOREIGN KEY (order_id) REFERENCES orders (id) ON DELETE SET NULL,
  INDEX idx_webhook_retry (is_successful, next_retry_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS audit_logs (
  id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  actor_type VARCHAR(20) NOT NULL,
  actor_id VARCHAR(255) NULL,
  merchant_id CHAR(36) NULL,
  entity_type VARCHAR(50) NOT NULL,
  entity_id VARCHAR(255) NOT NULL,
  action VARCHAR(100) NOT NULL,
  details JSON NULL,
  ip_address VARCHAR(45) NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_audit_merchant (merchant_id, created_at),
  INDEX idx_audit_entity (entity_type, entity_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS app_settings (
  setting_key VARCHAR(100) NOT NULL PRIMARY KEY,
  setting_value JSON NULL,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
