import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../config.js';
import { getPool, closePool } from './pool.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const migrationsDir = path.resolve(__dirname, '../../migrations');

export function listMigrationFiles(dir = migrationsDir) {
  return fs.readdirSync(dir).filter((f) => /^\d+_.*\.sql$/.test(f)).sort();
}

// Split a migration file into statements at each ";" terminator.
// Migration files in this project contain no ";" inside a string literal,
// so this split is safe for our own files and is checked by the migration
// test. The files remain directly runnable in phpMyAdmin / mysql CLI.
export function splitStatements(sql) {
  const withoutComments = sql
    .split('\n')
    .filter((line) => !line.trim().startsWith('--'))
    .join('\n');
  return withoutComments
    .split(/;\s*(?:\n|$)/)
    .map((s) => s.trim())
    .filter(Boolean);
}

export async function migrate({ config, apply = false, pool: poolOverride = null }) {
  const pool = poolOverride || getPool(config);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version VARCHAR(100) NOT NULL PRIMARY KEY,
      applied_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);
  const [appliedRows] = await pool.query('SELECT version FROM schema_migrations ORDER BY version ASC');
  const applied = new Set(appliedRows.map((r) => r.version));
  const results = [];
  for (const file of listMigrationFiles()) {
    const version = file.replace(/\.sql$/, '');
    if (applied.has(version)) {
      results.push({ version, status: 'already_applied' });
      continue;
    }
    const sql = fs.readFileSync(path.join(migrationsDir, file), 'utf8');
    if (!apply) {
      results.push({ version, status: 'pending' });
      continue;
    }
    const conn = await pool.getConnection();
    try {
      for (const stmt of splitStatements(sql)) {
        await conn.query(stmt);
      }
      await conn.query('INSERT INTO schema_migrations (version) VALUES (?)', [version]);
      results.push({ version, status: 'applied' });
    } finally {
      conn.release();
    }
  }
  return results;
}

// CLI: node src/db/migrate.js --status | --apply
const isCli = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(__dirname, 'migrate.js');
if (isCli) {
  const apply = process.argv.includes('--apply');
  const config = loadConfig();
  migrate({ config, apply })
    .then((results) => {
      for (const r of results) console.log(`${r.version}: ${r.status}`);
      if (!apply && results.some((r) => r.status === 'pending')) {
        console.log('Run with --apply to apply pending migrations.');
      }
    })
    .catch((err) => {
      console.error(`Migration failed: ${err.message}`);
      process.exitCode = 1;
    })
    .finally(() => closePool().catch(() => {}));
}
