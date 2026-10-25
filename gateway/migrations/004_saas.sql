-- 004: SaaS subscriptions, account security tokens, support messages.
-- Forward-only. No existing table is dropped or altered, and no existing
-- data is deleted. Prices below are admin-configurable defaults, not a
-- claim that a subscription fee has been paid; paid plans become active
-- only after manual billing verification by an admin (or a configured
-- provider confirmation, which is not included here).
CREATE TABLE IF NOT EXISTS subscription_plans (
  id CHAR(36) NOT NULL PRIMARY KEY,
  name VARCHAR(100) NOT NULL,
  slug VARCHAR(100) NOT NULL UNIQUE,
  description TEXT NULL,
  price_monthly_paise BIGINT NOT NULL DEFAULT 0,
  price_annual_paise BIGINT NOT NULL DEFAULT 0,
  transaction_limit INT NULL,
  api_limit INT NULL,
  features JSON NULL,
  is_active TINYINT(1) NOT NULL DEFAULT 1,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT chk_plan_price CHECK (price_monthly_paise >= 0 AND price_annual_paise >= 0),
  CONSTRAINT chk_plan_limit CHECK ((transaction_limit IS NULL OR transaction_limit > 0) AND (api_limit IS NULL OR api_limit > 0))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS merchant_subscriptions (
  id CHAR(36) NOT NULL PRIMARY KEY,
  merchant_id CHAR(36) NOT NULL,
  plan_id CHAR(36) NOT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'pending_payment',
  billing_cycle VARCHAR(20) NOT NULL DEFAULT 'monthly',
  plan_price_paise BIGINT NOT NULL DEFAULT 0,
  payment_status VARCHAR(20) NOT NULL DEFAULT 'pending_manual',
  billing_reference VARCHAR(255) NULL,
  billing_note TEXT NULL,
  billing_verified_by VARCHAR(255) NULL,
  billing_verified_at DATETIME NULL,
  started_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  renews_at DATETIME NULL,
  expires_at DATETIME NULL,
  grace_until DATETIME NULL,
  cancelled_at DATETIME NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT fk_sub_merchant FOREIGN KEY (merchant_id) REFERENCES merchants (id) ON DELETE CASCADE,
  CONSTRAINT fk_sub_plan FOREIGN KEY (plan_id) REFERENCES subscription_plans (id),
  CONSTRAINT chk_sub_status CHECK (status IN ('active', 'pending_payment', 'cancelled', 'expired', 'past_due')),
  CONSTRAINT chk_sub_payment CHECK (payment_status IN ('not_required', 'pending_manual', 'verified_manual', 'verified_provider', 'failed')),
  CONSTRAINT chk_sub_cycle CHECK (billing_cycle IN ('monthly', 'annual')),
  INDEX idx_sub_merchant (merchant_id, status, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS password_resets (
  id CHAR(36) NOT NULL PRIMARY KEY,
  user_type VARCHAR(20) NOT NULL,
  user_id CHAR(36) NOT NULL,
  token_hash CHAR(64) NOT NULL UNIQUE,
  expires_at DATETIME NOT NULL,
  used_at DATETIME NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT chk_reset_type CHECK (user_type IN ('merchant', 'admin')),
  INDEX idx_reset_user (user_type, user_id, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS email_verifications (
  id CHAR(36) NOT NULL PRIMARY KEY,
  merchant_id CHAR(36) NOT NULL,
  token_hash CHAR(64) NOT NULL UNIQUE,
  expires_at DATETIME NOT NULL,
  verified_at DATETIME NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_verify_merchant FOREIGN KEY (merchant_id) REFERENCES merchants (id) ON DELETE CASCADE,
  INDEX idx_verify_merchant (merchant_id, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS support_messages (
  id CHAR(36) NOT NULL PRIMARY KEY,
  merchant_id CHAR(36) NULL,
  name VARCHAR(255) NOT NULL,
  email VARCHAR(255) NOT NULL,
  subject VARCHAR(255) NOT NULL,
  message TEXT NOT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'open',
  admin_reply TEXT NULL,
  replied_at DATETIME NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT fk_support_merchant FOREIGN KEY (merchant_id) REFERENCES merchants (id) ON DELETE SET NULL,
  CONSTRAINT chk_support_status CHECK (status IN ('open', 'answered', 'closed')),
  INDEX idx_support_status (status, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

INSERT IGNORE INTO subscription_plans (id, name, slug, description, price_monthly_paise, price_annual_paise, transaction_limit, api_limit, features, is_active) VALUES
  (UUID(), 'Free', 'free', 'Start with UPI checkout, dashboard and manual verification.', 0, 0, 100, 100, '["UPI QR checkout", "Merchant dashboard", "Manual verification", "Webhooks"]', 1),
  (UUID(), 'Basic', 'basic', 'For small stores getting started with online payments.', 49900, 499000, 1000, 5000, '["Everything in Free", "Higher transaction limits", "API access", "Webhook retries"]', 1),
  (UUID(), 'Pro', 'pro', 'For growing businesses with higher volume.', 149900, 1499000, 10000, 50000, '["Everything in Basic", "Priority support", "Usage reports", "Subscription management"]', 1),
  (UUID(), 'Business', 'business', 'For high-volume merchants. No monthly transaction cap in this plan.', 399900, 3999000, NULL, NULL, '["Everything in Pro", "Unlimited transactions", "Unlimited API calls", "Dedicated support channel"]', 1);
