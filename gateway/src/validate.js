export function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function isEmail(value) {
  return typeof value === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(value.trim());
}

export function isSlug(value) {
  return typeof value === 'string' && /^[a-z0-9][a-z0-9-]{2,98}$/.test(value.trim());
}

export function isUpiId(value) {
  return typeof value === 'string' && /^[a-zA-Z0-9._-]{2,}@[a-zA-Z][a-zA-Z0-9.-]*$/.test(value.trim());
}

export function isUtr(value) {
  return typeof value === 'string' && /^[0-9]{12}$/.test(value.trim());
}

// Parse a rupee amount string ("499", "499.00", "0.05") into integer paise
// without floating point. Returns null for invalid input.
export function parseRupeesToPaise(value) {
  if (typeof value === 'number') {
    if (!Number.isInteger(value) || value <= 0) return null;
    return value; // already paise when passed as an integer from the API
  }
  if (typeof value !== 'string') return null;
  const m = /^([0-9]+)(?:\.([0-9]{1,2}))?$/.exec(value.trim());
  if (!m) return null;
  const paise = BigInt(m[1]) * 100n + BigInt((m[2] || '0').padEnd(2, '0'));
  if (paise <= 0n || paise > 100000000000n) return null;
  return Number(paise);
}

export function parseAmountPaise(body) {
  if (body.amount_paise !== undefined && body.amount_paise !== null && body.amount_paise !== '') {
    const n = Number(body.amount_paise);
    if (!Number.isInteger(n) || n <= 0 || n > 100000000000) return null;
    return n;
  }
  if (body.amount !== undefined && body.amount !== null && body.amount !== '') {
    return parseRupeesToPaise(String(body.amount));
  }
  return null;
}

// A return URL must be a plain http(s) URL. This blocks javascript:,
// data: and other schemes that would otherwise be linked from the
// checkout page, while still allowing a merchant's own site (and
// localhost test URLs) as a return destination.
export function validateReturnUrl(value) {
  if (value === undefined || value === null) return '';
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (trimmed === '') return '';
  try {
    const url = new URL(trimmed);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    return trimmed;
  } catch {
    return null;
  }
}

export function cleanString(value, max = 255) {
  if (typeof value !== 'string') return '';
  return value.trim().slice(0, max);
}

export function pagination(query) {
  const page = Math.max(1, Number.parseInt(query.page, 10) || 1);
  const perPage = Math.min(50, Math.max(5, Number.parseInt(query.per_page, 10) || 20));
  return { page, perPage, offset: (page - 1) * perPage };
}

export function formatPaise(paise) {
  const n = BigInt(paise || 0);
  return `₹${(n / 100n).toString()}.${(n % 100n).toString().padStart(2, '0')}`;
}

export function formatDate(value) {
  if (!value) return '—';
  const d = parseDbDateUtc(value);
  if (Number.isNaN(d.getTime())) return String(value);
  return d.toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' });
}

// MySQL DATETIME/TIMESTAMP values arrive as plain strings like
// "2026-10-25 12:30:00" (dateStrings: true) in UTC, because the app stores
// UTC_TIMESTAMP(). Parsing them with `new Date(string)` would treat them
// as the server's local timezone, which can make an order look expired
// immediately on a host whose local timezone is not UTC. Parse as UTC.
export function parseDbDateUtc(value) {
  if (value instanceof Date) return value;
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}/.test(trimmed)) {
      return new Date(`${trimmed.slice(0, 19)}Z`);
    }
    return new Date(trimmed);
  }
  return new Date(value);
}
