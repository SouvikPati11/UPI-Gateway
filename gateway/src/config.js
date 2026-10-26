import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Minimal .env parser for LOCAL development only.
// On cPanel, variables come from the Node.js App panel, which take precedence
// because we never overwrite an already-set process.env variable.
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const gatewayRoot = path.resolve(__dirname, '..');

export function loadLocalEnvFile() {
  const envPath = path.join(gatewayRoot, '.env');
  if (!fs.existsSync(envPath)) return;
  for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

const PLACEHOLDER_PATTERNS = [
  /change-me/i,
  /replace_with/i,
  /example\.com/i,
  /your-/i,
  /^password$/i,
  /^secret$/i,
];

function isPlaceholder(value) {
  if (typeof value !== 'string') return true;
  const v = value.trim();
  if (!v) return true;
  return PLACEHOLDER_PATTERNS.some((re) => re.test(v));
}

/**
 * Validate configuration. Returns { config, errors }.
 * In production, ANY error is fatal: the server must not boot with a
 * placeholder secret, a missing database, or an example base URL.
 * In development/test, database settings may be absent so that /health
 * and the pure-logic tests can run without MySQL; production validation
 * is still exercised explicitly by the tests.
 */
export function validateConfig(env = process.env) {
  const errors = [];
  const nodeEnv = (env.NODE_ENV || 'development').trim();
  const isProduction = nodeEnv === 'production';

  const sessionSecret = env.SESSION_SECRET || '';
  const encryptionKey = env.ENCRYPTION_MASTER_KEY || '';
  const baseUrl = env.APP_BASE_URL || '';

  if (isProduction) {
    if (isPlaceholder(sessionSecret) || sessionSecret.trim().length < 32) {
      errors.push('SESSION_SECRET is missing, a placeholder, or shorter than 32 characters.');
    }
    if (isPlaceholder(encryptionKey) || !/^[0-9a-fA-F]{64}$/.test(encryptionKey.trim())) {
      errors.push('ENCRYPTION_MASTER_KEY must be exactly 64 hex characters, not a placeholder.');
    }
    if (isPlaceholder(baseUrl)) {
      errors.push('APP_BASE_URL is missing or a placeholder (example.com / change-me).');
    }
    for (const key of ['DB_HOST', 'DB_USER', 'DB_PASSWORD', 'DB_NAME']) {
      if (isPlaceholder(env[key])) errors.push(`${key} is missing or a placeholder.`);
    }
    const dbPort = Number(env.DB_PORT || 3306);
    if (!Number.isInteger(dbPort) || dbPort < 1 || dbPort > 65535) {
      errors.push('DB_PORT must be an integer between 1 and 65535.');
    }
  } else {
    // Non-production: still flag obvious placeholders so a developer does not
    // accidentally promote a dev file, but do not require a database.
    if (sessionSecret && isPlaceholder(sessionSecret)) {
      errors.push('SESSION_SECRET looks like a placeholder (non-production warning, treated as an error by tests for production only).');
    }
  }

  const verificationMode = (env.VERIFICATION_MODE || 'manual').trim();
  if (!['manual', 'observer', 'provider'].includes(verificationMode)) {
    errors.push(`VERIFICATION_MODE must be one of: manual, observer, provider. Got: ${verificationMode}`);
  }

  // PORT: Hostinger assigns a valid port. If PORT is set but is not a valid
  // TCP port, record an error and fall back to 3000 so the server can still
  // listen and report the problem on /install/diagnostics instead of
  // crashing before listen() (which Hostinger reports as
  // "App did not call listen() within 3 seconds").
  let port = 3000;
  if (env.PORT !== undefined && env.PORT !== '') {
    const parsed = Number(env.PORT);
    if (Number.isInteger(parsed) && parsed >= 1 && parsed <= 65535) {
      port = parsed;
    } else {
      errors.push(`PORT is not a valid TCP port. Got: ${String(env.PORT)}`);
    }
  }

  const config = {
    nodeEnv,
    isProduction,
    port,
    appName: (env.APP_NAME || 'YOUPI PG').trim(),
    baseUrl: baseUrl.trim(),
    verificationMode,
    db: {
      host: env.DB_HOST || '',
      port: Number(env.DB_PORT || 3306),
      user: env.DB_USER || '',
      password: env.DB_PASSWORD || '',
      database: env.DB_NAME || '',
      connectionLimit: Number(env.DB_CONNECTION_LIMIT || 5),
      configured: Boolean(env.DB_HOST && env.DB_USER && env.DB_NAME),
    },
    sessionSecret,
    encryptionKey,
  };
  return { config, errors };
}

export function loadConfig(env = process.env) {
  loadLocalEnvFile();
  const { config, errors } = validateConfig(env);
  if (config.isProduction && errors.length > 0) {
    throw new Error(`Production configuration invalid:\n- ${errors.join('\n- ')}`);
  }
  return config;
}
