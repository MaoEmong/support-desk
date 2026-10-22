import { config } from 'dotenv';
import { Pool } from 'pg';
import { fileURLToPath } from 'node:url';
import { runMigrations } from './migrations';
config({ path: fileURLToPath(new URL('../../../.env', import.meta.url)) });
if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required');
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 1 });
try { await runMigrations(pool); } finally { await pool.end(); }
