import mysql from 'mysql2/promise';

// The pool is created lazily and only when database settings are present.
// Creating it at import time would make /health and the pure-logic tests
// depend on MySQL, which Stage 1 explicitly does not require.
let pool = null;

export function getPool(config) {
  if (pool) return pool;
  if (!config?.db?.configured) {
    throw new Error('Database is not configured (DB_HOST, DB_USER and DB_NAME are required).');
  }
  pool = mysql.createPool({
    host: config.db.host,
    port: config.db.port,
    user: config.db.user,
    password: config.db.password,
    database: config.db.database,
    connectionLimit: config.db.connectionLimit,
    waitForConnections: true,
    queueLimit: 0,
    // Dates are handled as UTC DATETIME strings by the application; do not
    // let the driver silently shift them into local time.
    dateStrings: true,
    // Parameterised queries only. mysql2 supports multipleStatements=false
    // by default; keep it that way so a migration file cannot smuggle in
    // a second statement through a query parameter.
    multipleStatements: false,
  });
  return pool;
}

export async function pingDatabase(config) {
  const p = getPool(config);
  const conn = await p.getConnection();
  try {
    await conn.query('SELECT 1 AS ok');
    return true;
  } finally {
    conn.release();
  }
}

export async function closePool() {
  if (pool) {
    await pool.end();
    pool = null;
  }
}
