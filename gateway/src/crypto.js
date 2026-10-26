import crypto from 'node:crypto';

export function sha256Hex(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

export function hmacHex(secret, value) {
  return crypto.createHmac('sha256', String(secret)).update(String(value)).digest('hex');
}

export function timingSafeEqualString(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

// Password hashing: scrypt with a random salt. Stored format:
// scrypt:<iterations>:<saltHex>:<hashHex>. No password is ever stored plain.
export function hashPassword(password) {
  if (typeof password !== 'string' || password.length < 10) {
    throw new Error('Password must be at least 10 characters.');
  }
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, 64, { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
  return `scrypt:16384:${salt.toString('hex')}:${hash.toString('hex')}`;
}

export function verifyPassword(password, stored) {
  try {
    const parts = String(stored).split(':');
    if (parts.length !== 4 || parts[0] !== 'scrypt') return false;
    const iterations = Number(parts[1]);
    const salt = Buffer.from(parts[2], 'hex');
    const expected = Buffer.from(parts[3], 'hex');
    const actual = crypto.scryptSync(String(password), salt, expected.length, { N: iterations, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
    return crypto.timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

// AES-256-GCM encryption at rest for webhook secrets. The key must be
// exactly 32 bytes (64 hex chars) from ENCRYPTION_MASTER_KEY.
// Stored format: base64(iv):base64(authTag):base64(ciphertext).
export function encryptAtRest(plaintext, keyHex) {
  const key = Buffer.from(String(keyHex), 'hex');
  if (key.length !== 32) throw new Error('ENCRYPTION_MASTER_KEY must be exactly 64 hex characters.');
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${iv.toString('base64')}:${tag.toString('base64')}:${ciphertext.toString('base64')}`;
}

export function decryptAtRest(stored, keyHex) {
  const key = Buffer.from(String(keyHex), 'hex');
  if (key.length !== 32) throw new Error('ENCRYPTION_MASTER_KEY must be exactly 64 hex characters.');
  const [ivB64, tagB64, dataB64] = String(stored).split(':');
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(ivB64, 'base64'));
  decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(dataB64, 'base64')), decipher.final()]).toString('utf8');
}

export function randomToken(bytes = 32) {
  return crypto.randomBytes(bytes).toString('hex');
}

// API keys: public keys are publishable and stored in plain (public_value).
// Secret keys are NEVER stored in plain: only prefix + sha256 hash are stored,
// and the full secret is shown exactly once at creation time.
export function generateApiKey(type) {
  if (type === 'public') {
    const value = `pk_${crypto.randomBytes(16).toString('hex')}`;
    return { value, prefix: value.slice(0, 12), hash: sha256Hex(value) };
  }
  const value = `sk_${crypto.randomBytes(24).toString('hex')}`;
  return { value, prefix: value.slice(0, 12), hash: sha256Hex(value) };
}

export function generateGatewayReference() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let suffix = '';
  for (let i = 0; i < 10; i++) suffix += chars[crypto.randomInt(chars.length)];
  const date = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  return `YP${date}${suffix}`;
}

export function generateWebhookSecret() {
  return crypto.randomBytes(32).toString('hex');
}
