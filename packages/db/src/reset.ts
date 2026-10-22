import { Pool } from 'pg';

export function validateResetTarget(connectionString: string): { database: string; maintenanceUrl: string } {
  const parsed = new URL(connectionString);
  const database = decodeURIComponent(parsed.pathname.slice(1));
  if (!['postgres:', 'postgresql:'].includes(parsed.protocol)
    || !['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname)
    || parsed.search || parsed.hash
    || !/^[A-Za-z_][A-Za-z0-9_]*_e2e$/.test(database)) {
    throw new Error('--reset requires a local PostgreSQL database named <identifier>_e2e, without query/fragment overrides');
  }
  parsed.pathname = '/postgres';
  return { database, maintenanceUrl: parsed.toString() };
}

/** Explicit seed --reset only. Never terminates existing connections or uses DROP FORCE. */
export async function resetE2EDatabase(connectionString: string): Promise<void> {
  const { database, maintenanceUrl } = validateResetTarget(connectionString);
  const admin = new Pool({ connectionString: maintenanceUrl, max: 1 });
  try {
    const connection = await admin.connect();
    try {
      await connection.query('SELECT pg_advisory_lock(hashtext($1))', [`support-desk-reset:${database}`]);
      const { rows: [activity] } = await connection.query<{ count: number }>('SELECT count(*)::int AS count FROM pg_stat_activity WHERE datname=$1', [database]);
      if (activity.count > 0) throw new Error('--reset refused: target database has active connections; stop its owning application first');
      // database was validated as a single identifier before either destructive statement.
      await connection.query(`DROP DATABASE IF EXISTS "${database}"`);
      await connection.query(`CREATE DATABASE "${database}"`);
      console.log('Recreated validated local _e2e database');
    } finally { connection.release(); }
  } finally { await admin.end(); }
}
