import { randomToken, sha256Hex, hmacHex, timingSafeEqualString } from './crypto.js';

// Sessions: only the sha256 hash of the token is stored in the database.
// The plain token lives only in the HttpOnly cookie.
export async function createSession(pool, actorType, actorId, ip, userAgent, hours = 24) {
  const token = randomToken(32);
  const { randomUUID } = await import('node:crypto');
  const sessionId = randomUUID();
  const expires = new Date(Date.now() + hours * 3600 * 1000).toISOString().slice(0, 19).replace('T', ' ');
  await pool.query(
    'INSERT INTO sessions (id, actor_type, actor_id, token_hash, ip_address, user_agent, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    [sessionId, actorType, actorId, sha256Hex(token), ip || null, (userAgent || '').slice(0, 500), expires],
  );
  return { sessionId, token, expires };
}

export async function getSession(pool, token) {
  if (!token) return null;
  const [rows] = await pool.query(
    'SELECT * FROM sessions WHERE token_hash = ? AND expires_at > UTC_TIMESTAMP()',
    [sha256Hex(token)],
  );
  return rows[0] || null;
}

export async function deleteSession(pool, token) {
  if (!token) return;
  await pool.query('DELETE FROM sessions WHERE token_hash = ?', [sha256Hex(token)]);
}

export function sessionCookieOptions(config) {
  const secure = config.isProduction || (config.baseUrl || '').startsWith('https://');
  return {
    httpOnly: true,
    secure,
    sameSite: 'lax',
    path: '/',
    maxAge: 24 * 3600 * 1000,
  };
}

// CSRF: HMAC of the session token with SESSION_SECRET. No extra table is
// needed, and an attacker without the HttpOnly session cookie cannot forge it.
export function csrfTokenFor(sessionToken, sessionSecret) {
  return hmacHex(sessionSecret, sessionToken);
}

export function verifyCsrf(provided, sessionToken, sessionSecret) {
  if (!provided || !sessionToken || !sessionSecret) return false;
  return timingSafeEqualString(provided, csrfTokenFor(sessionToken, sessionSecret));
}

// Simple in-memory rate limiter: key -> { count, resetAt }.
// This is per-process, which is correct for a single cPanel Node app.
// Limits are intentionally generous for normal use and strict for logins.
export function createRateLimiter({ windowMs, max }) {
  const store = new Map();
  return function rateLimit(req, res, next) {
    const key = `${req.ip}:${req.path}`;
    const now = Date.now();
    const entry = store.get(key);
    if (!entry || entry.resetAt <= now) {
      store.set(key, { count: 1, resetAt: now + windowMs });
      return next();
    }
    entry.count += 1;
    if (entry.count > max) {
      return res.status(429).json({ error: 'Too many requests. Please wait and try again.' });
    }
    return next();
  };
}
