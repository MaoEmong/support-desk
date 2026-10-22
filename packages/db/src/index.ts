import { Pool } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import * as schema from './schema';
import { config } from 'dotenv';
import { resolve } from 'node:path';
// Resolve at runtime so Next does not treat .env as a bundled module asset.
config({ path: [resolve(process.cwd(), '.env'), resolve(process.cwd(), '../../.env')] });
// Pool opens connections lazily. Server code owns the shared pool lifecycle.
export const pool = new Pool({ connectionString: process.env.DATABASE_URL ?? 'postgresql://support:support@localhost:5432/support_desk', max: 10 });
export const client = pool;
export const db = drizzle(pool, { schema });
export { schema };
export * from './schema';
export type Database = typeof db;
