// Account security tokens: password resets and email verification.
// Only the SHA-256 hash of a token is stored. The plain token is
// delivered only by email (when an SMTP service is configured) or, in
// tests, through the helper that creates it. It is never shown in a
// page, a log, or an API response, and a reset request never reveals
// whether an account exists.
import { randomUUID, randomBytes } from 'node:crypto';
import { sha256Hex } from './crypto.js';

export function generateToken() {
  return randomBytes(32).toString('hex');
}

export function tokenExpiryHours(hours = 1) {
  return new Date(Date.now() + hours * 3600 * 1000).toISOString().slice(0, 19).replace('T', ' ');
}

export async function createPasswordReset(pool, userType, userId, hours = 1) {
  const token = generateToken();
  const id = randomUUID();
  await pool.query(
    'INSERT INTO password_resets (id, user_type, user_id, token_hash, expires_at) VALUES (?, ?, ?, ?, ?)',
    [id, userType, userId, sha256Hex(token), tokenExpiryHours(hours)],
  );
  return { id, token };
}

export async function findValidPasswordReset(pool, token) {
  if (!token) return null;
  const [rows] = await pool.query(
    'SELECT * FROM password_resets WHERE token_hash = ? AND used_at IS NULL AND expires_at > UTC_TIMESTAMP()',
    [sha256Hex(token)],
  );
  return rows[0] || null;
}

export async function markPasswordResetUsed(pool, resetId) {
  await pool.query('UPDATE password_resets SET used_at = UTC_TIMESTAMP() WHERE id = ?', [resetId]);
}

export async function createEmailVerification(pool, merchantId, hours = 24) {
  const token = generateToken();
  const id = randomUUID();
  await pool.query(
    'INSERT INTO email_verifications (id, merchant_id, token_hash, expires_at) VALUES (?, ?, ?, ?)',
    [id, merchantId, sha256Hex(token), tokenExpiryHours(hours)],
  );
  return { id, token };
}

export async function findValidEmailVerification(pool, token) {
  if (!token) return null;
  const [rows] = await pool.query(
    'SELECT * FROM email_verifications WHERE token_hash = ? AND verified_at IS NULL AND expires_at > UTC_TIMESTAMP()',
    [sha256Hex(token)],
  );
  return rows[0] || null;
}

export async function isEmailVerified(pool, merchantId) {
  const [rows] = await pool.query(
    'SELECT * FROM email_verifications WHERE merchant_id = ? AND verified_at IS NOT NULL ORDER BY verified_at DESC LIMIT 1',
    [merchantId],
  );
  return Boolean(rows[0]);
}
