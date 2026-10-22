import type { Pool } from 'pg';
import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';

export async function runMigrations(pool: Pool): Promise<void> {
  const tx = await pool.connect();
  try {
    await tx.query('BEGIN');
    await tx.query('SELECT pg_advisory_xact_lock(5340001)');
    await tx.query('CREATE TABLE IF NOT EXISTS support_migrations (name text PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())');
    const directory = new URL('../drizzle/', import.meta.url);
    for (const name of (await readdir(directory)).filter(file => file.endsWith('.sql')).sort()) {
      const source = await readFile(new URL(name, directory), 'utf8');
      const checksum = createHash('sha256').update(source).digest('hex');
      const { rows: [prior] } = await tx.query<{ checksum: string }>('SELECT checksum FROM support_migrations WHERE name=$1', [name]);
      if (prior) {
        if (prior.checksum !== checksum) throw new Error(`Applied migration changed: ${name}`);
        continue;
      }
      await tx.query(source);
      await tx.query('INSERT INTO support_migrations(name,checksum) VALUES($1,$2)', [name, checksum]);
      console.log(`Applied ${name}`);
    }
    await tx.query('COMMIT');
  } catch (error) {
    await tx.query('ROLLBACK');
    throw error;
  } finally { tx.release(); }
}
