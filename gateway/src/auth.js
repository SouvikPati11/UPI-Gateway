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

export function sessionCookieOptions(config, req) {
  // Secure follows the actual request protocol (trust-proxy aware), not
  // NODE_ENV alone. Forcing secure on a plain-HTTP visit behind a proxy
  // made browsers refuse to store the session cookie at all, so login
  // appeared to fail (redirect back to the login page) even with correct
  // credentials. On HTTPS the cookie stays Secure, as before.
  const secure = Boolean(req?.secure) || (config.baseUrl || '').startsWith('https://');
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
    // Key on the account identifier as well as the IP. Behind a shared
    // proxy/CDN many users can share one req.ip, so a per-IP-only bucket
    // let one person's retries block everyone else's login. Per-account
    // keying keeps brute-force protection per account while fixing that.
    const rawEmail = req.body?.email || req.body?.contact_email || '';
    const email = typeof rawEmail === 'string' ? rawEmail.toLowerCase().trim() : '';
    const key = `${req.ip}:${req.path}:${email}`;
    const now = Date.now();
    const entry = store.get(key);
    if (!entry || entry.resetAt <= now) {
      store.set(key, { count: 1, resetAt: now + windowMs });
      return next();
    }
    entry.count += 1;
    if (entry.count > max) {
      // Browser form posts used to get a raw JSON body here, which looked
      // like a broken page. Serve a styled message for HTML clients and
      // keep JSON for API clients.
      const acceptsHtml = (req.headers.accept || '').includes('text/html');
      if (acceptsHtml) {
        return res.status(429).send(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Too many attempts — YOUPI PG</title><style>body{font-family:system-ui,-apple-system,sans-serif;background:#f1f5f9;color:#0f172a;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;padding:1rem}main{background:#fff;border:1px solid #e2e8f0;border-radius:16px;box-shadow:0 10px 30px rgba(15,23,42,.08);padding:2rem;max-width:440px}h1{font-size:1.4rem;margin:0 0 .5rem}a{color:#4f46e5;font-weight:600}</style></head><body><main><h1>Too many attempts</h1><p>For your security, sign-in attempts are limited. Please wait a few minutes and try again.</p><p><a href="/merchant/login">Back to merchant login</a> · <a href="/admin/login">Admin login</a></p></main></body></html>`);
      }
      return res.status(429).json({ error: 'Too many requests. Please wait and try again.' });
    }
    return next();
  };
}
