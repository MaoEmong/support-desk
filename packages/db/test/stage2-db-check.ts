import { config, parse } from 'dotenv';
import { readFileSync } from 'node:fs';
import { Pool } from 'pg';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { runMigrations } from '../src/migrations';

config({ path: fileURLToPath(new URL('../../../.env', import.meta.url)), quiet: true });
let connection = process.env.DATABASE_URL;
if (!connection) {
  const example = parse(readFileSync(new URL('../../../.env.example', import.meta.url)));
  const local = new URL(example.DATABASE_URL);
  local.port = '55432'; // Docker compose ps confirmed this local published port.
  connection = local.toString();
  console.log('No root .env: using public .env.example with confirmed local Docker port 55432');
}
const target = new URL(connection);
assert(['localhost', '127.0.0.1', '[::1]'].includes(target.hostname));
const existing = process.env.STAGE2_DATABASE_NAME;
const name = existing ?? `support_stage2_${Date.now()}_e2e`;
assert(/^support_stage2_[0-9]+_e2e$/.test(name));
const maintenance = new URL(target); maintenance.pathname = '/postgres';
const admin = new Pool({ connectionString: maintenance.toString(), max: 1 });
try { if (!existing) await admin.query(`CREATE DATABASE "${name}"`); } finally { await admin.end(); }
target.pathname = `/${name}`;
console.log(`${existing ? 'Reusing owned disposable' : 'Created independent empty'} DB ${name}; no existing DB/schema deleted`);
const pool = new Pool({ connectionString: target.toString(), max: 1 });
try {
  if (existing) {
    const before = await pool.query('SELECT ai_threshold FROM tenant_settings ORDER BY tenant_id');
    console.log('Thresholds before explicit four-decimal normalization:', JSON.stringify(before.rows));
  }
  await runMigrations(pool);
  const threshold = await pool.query("SELECT data_type FROM information_schema.columns WHERE table_schema='public' AND table_name='tenant_settings' AND column_name='ai_threshold'");
  assert.equal(threshold.rows[0]?.data_type, 'double precision');
  console.log('ai_threshold SQL type: double precision');
  if (existing) console.log('Thresholds after four-decimal normalization:', JSON.stringify((await pool.query('SELECT ai_threshold FROM tenant_settings ORDER BY tenant_id')).rows));
  const tx = await pool.connect();
  try {
    await tx.query('BEGIN');
    const tenant = randomUUID(), user = randomUUID(), conversation = randomUUID(), message = randomUUID(), run = randomUUID(), draft = randomUUID(), ticket = randomUUID();
    await tx.query("INSERT INTO tenants(id,slug,name) VALUES($1,$2,'constraint check')", [tenant, `check-${tenant}`]);
    await tx.query("INSERT INTO users(id,tenant_id,email,name,password_hash,role) VALUES($1,$2,'check@example.test','check','unused','customer')", [user, tenant]);
    await tx.query('INSERT INTO conversations(id,tenant_id,customer_id) VALUES($1,$2,$3)', [conversation, tenant, user]);
    await tx.query("INSERT INTO conversation_messages(id,tenant_id,conversation_id,role,body,reason,notice_code) VALUES($1,$2,$3,'system','안내','approval_mode','APPROVAL_REQUIRED')", [message, tenant, conversation]);
    await tx.query("INSERT INTO ai_runs(id,tenant_id,conversation_id,message_id,status) VALUES($1,$2,$3,$4,'succeeded')", [run, tenant, conversation, message]);
    await tx.query("INSERT INTO ai_drafts(id,tenant_id,conversation_id,run_id,body) VALUES($1,$2,$3,$4,'same draft')", [draft, tenant, conversation, run]);
    await tx.query("INSERT INTO tickets(id,tenant_id,customer_id,title,body,conversation_id) VALUES($1,$2,$3,'converted','body',$4)", [ticket, tenant, user, conversation]);
    await tx.query('UPDATE ai_drafts SET ticket_id=$1 WHERE id=$2', [ticket, draft]);
    const { rows: [saved] } = await tx.query('SELECT * FROM ai_drafts WHERE id=$1', [draft]);
    assert.equal(saved.conversation_id, conversation); assert.equal(saved.ticket_id, ticket);
    assert.equal(saved.run_id, run); assert.equal(saved.body, 'same draft'); assert.equal(saved.job_id, null);
    async function rejects(query: string, params: unknown[], code: string) {
      await tx.query('SAVEPOINT invalid_case');
      let actual: string | undefined;
      try { await tx.query(query, params); } catch (error) { actual = (error as { code?: string }).code; }
      await tx.query('ROLLBACK TO SAVEPOINT invalid_case');
      assert.equal(actual, code);
    }
    await rejects('INSERT INTO ai_runs(tenant_id,conversation_id,message_id) VALUES($1,$2,$3)', [tenant, conversation, message], '23505');
    await rejects('INSERT INTO ai_runs(tenant_id,conversation_id) VALUES($1,$2)', [tenant, conversation], '23514');
    await rejects('INSERT INTO ai_runs(tenant_id,ticket_id,conversation_id,message_id) VALUES($1,$2,$3,$4)', [tenant, ticket, conversation, message], '23514');
    await rejects('UPDATE ai_drafts SET conversation_id=NULL WHERE id=$1', [draft], '23514');
    await rejects("INSERT INTO ai_drafts(tenant_id,conversation_id,run_id,body) VALUES($1,$2,$3,'duplicate')", [tenant, conversation, run], '23505');
    await rejects("INSERT INTO tenant_settings(tenant_id,fallback_category,auto_answer_limit) VALUES($1,'other',0)", [tenant], '23514');
    await tx.query('COMMIT');
    console.log('DB checks: conversion preserves draft/conversation/run/body; run idempotency; message required; run target XOR; draft source XOR; unique conversation; fixed autoAnswerLimit: PASS');
  } catch (error) { await tx.query('ROLLBACK'); throw error; } finally { tx.release(); }
  const { rows: [migration] } = await pool.query('SELECT count(*)::int AS count FROM support_migrations');
  console.log(`Applied migration count: ${migration.count}`);
  const seed = fileURLToPath(new URL('../src/seed.ts', import.meta.url));
  const cli = fileURLToPath(new URL('../node_modules/tsx/dist/cli.mjs', import.meta.url));
  execFileSync(process.execPath, [cli, seed], { env: { ...process.env, DATABASE_URL: target.toString() }, stdio: 'inherit' });
  const { rows: counts } = await pool.query("SELECT slug,(SELECT count(*)::int FROM users u WHERE u.tenant_id=t.id) AS accounts FROM tenants t WHERE slug IN ('pixelforge','mailpulse') ORDER BY slug");
  assert.equal(counts.length, 2); assert(counts.every(row => row.accounts === 4));
  console.log('Seed tenant/account check:', JSON.stringify(counts));
  const confidence = await pool.query("SELECT count(*)::int AS checked, count(*) FILTER (WHERE confidence IS DISTINCT FROM (result#>>'{confidence,final}')::double precision)::int AS mismatches FROM ai_runs WHERE result#>>'{confidence,final}' IS NOT NULL");
  console.log('Stored confidence vs original JSON final:', JSON.stringify(confidence.rows[0]));
  assert.equal(confidence.rows[0].mismatches, 0);
  if (process.env.RUN_AI_KIT === '1') {
    const vitest = fileURLToPath(new URL('../../../node_modules/vitest/vitest.mjs', import.meta.url));
    const root = fileURLToPath(new URL('../../../', import.meta.url));
    execFileSync(process.execPath, [vitest, 'run', 'apps/web/src/server/__tests__/ai-contract.integration.test.ts'], {
      cwd: root, env: { ...process.env, TEST_DATABASE_URL: target.toString() }, stdio: 'inherit',
    });
  }
} finally { await pool.end(); }
