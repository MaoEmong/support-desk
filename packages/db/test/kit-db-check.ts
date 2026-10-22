import { config, parse } from 'dotenv';
import { readFileSync } from 'node:fs';
import { Pool } from 'pg';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { runMigrations } from '../src/migrations';

config({ path: fileURLToPath(new URL('../../../.env', import.meta.url)), quiet: true });
const example = parse(readFileSync(new URL('../../../.env.example', import.meta.url)));
const target = new URL(process.env.DATABASE_URL ?? example.DATABASE_URL);
if (!process.env.DATABASE_URL) target.port = '55432';
assert(['localhost', '127.0.0.1', '[::1]'].includes(target.hostname));
const name = `support_kit_${Date.now()}_verify`;
assert(/^support_kit_[0-9]+_verify$/.test(name));
const ownership = `kit-db-check:${randomUUID()}`;
const maintenance = new URL(target); maintenance.pathname = '/postgres';
const admin = new Pool({ connectionString: maintenance.toString(), max: 1 });
let pool: Pool | undefined;
let created = false;
try {
  await admin.query(`CREATE DATABASE "${name}"`); created = true;
  await admin.query(`COMMENT ON DATABASE "${name}" IS '${ownership}'`);
  target.pathname = `/${name}`;
  pool = new Pool({ connectionString: target.toString(), max: 1 });
  console.log(`Created owned independent non-E2E empty DB ${name}`);
  await runMigrations(pool);
  execFileSync(process.execPath, [fileURLToPath(new URL('../node_modules/tsx/dist/cli.mjs', import.meta.url)), fileURLToPath(new URL('../src/seed.ts', import.meta.url))], {
    env: { ...process.env, DATABASE_URL: target.toString() }, stdio: 'inherit',
  });
  const { rows: counts } = await pool.query("SELECT slug,(SELECT count(*)::int FROM users u WHERE u.tenant_id=t.id) AS accounts FROM tenants t ORDER BY slug");
  assert.equal(counts.length, 2); assert(counts.every(row => row.accounts === 4));
  console.log('Actual seed tenant/account counts:', JSON.stringify(counts));
  execFileSync(process.execPath, [fileURLToPath(new URL('../../../node_modules/vitest/vitest.mjs', import.meta.url)), 'run', 'apps/web/src/server/__tests__/ai-contract.integration.test.ts'], {
    cwd: fileURLToPath(new URL('../../../', import.meta.url)), env: { ...process.env, TEST_DATABASE_URL: target.toString() }, stdio: 'inherit',
  });
} finally {
  await pool?.end();
  if (created) {
    const { rows: [owned] } = await admin.query("SELECT shobj_description(oid,'pg_database') AS owner FROM pg_database WHERE datname=$1", [name]);
    assert.equal(owned?.owner, ownership);
    const { rows: [activity] } = await admin.query('SELECT count(*)::int AS connections FROM pg_stat_activity WHERE datname=$1', [name]);
    assert.equal(activity.connections, 0, 'Refuse cleanup while any target connection remains');
    await admin.query(`DROP DATABASE "${name}"`);
    console.log(`Dropped only verified owned DB ${name}; shared DB untouched`);
  }
  await admin.end();
}
