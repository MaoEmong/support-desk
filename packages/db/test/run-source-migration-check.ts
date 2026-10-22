import assert from 'node:assert/strict';
import { config, parse } from 'dotenv';
import { readFileSync, readdirSync } from 'node:fs';
import { Pool } from 'pg';
import { createHash, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { runMigrations } from '../src/migrations';

config({ path: fileURLToPath(new URL('../../../.env', import.meta.url)), quiet: true });
const target = new URL(process.env.DATABASE_URL ?? parse(readFileSync(new URL('../../../.env.example', import.meta.url))).DATABASE_URL);
if (!process.env.DATABASE_URL) target.port = '55432';
assert(['localhost', '127.0.0.1', '[::1]'].includes(target.hostname));
const name = `support_runsource_${Date.now()}_e2e`;
assert(/^support_runsource_[0-9]+_e2e$/.test(name));
const maintenance = new URL(target); maintenance.pathname = '/postgres'; target.pathname = `/${name}`;
const owner = `run-source-check:${randomUUID()}`;
const admin = new Pool({ connectionString: maintenance.toString(), max: 1 });
const pool = new Pool({ connectionString: target.toString(), max: 1 });
let created = false;
try {
  await admin.query(`CREATE DATABASE "${name}"`); created = true;
  await admin.query(`COMMENT ON DATABASE "${name}" IS '${owner}'`);
  console.log(`Created owned DB ${name}`);
  // Prepare the exact historical SQL and checksum ledger through 0012, allowing
  // representative existing rows to be inspected BEFORE the new migration.
  const directory = new URL('../drizzle/', import.meta.url);
  for (const migration of readdirSync(directory).filter(file => file.endsWith('.sql') && file < '0013').sort()) {
    const source = readFileSync(new URL(migration, directory), 'utf8');
    await pool.query(source);
    await pool.query('CREATE TABLE IF NOT EXISTS support_migrations(name text PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())');
    await pool.query('INSERT INTO support_migrations(name,checksum) VALUES($1,$2)', [migration, createHash('sha256').update(source).digest('hex')]);
  }
  const tenant = randomUUID(), user = randomUUID(), ticket = randomUUID(), message = randomUUID(), job = randomUUID(), workerRun = randomUUID(), conv = randomUUID(), chatMessage = randomUUID(), sseRun = randomUUID();
  await pool.query("INSERT INTO tenants(id,slug,name) VALUES($1,'run-source-test','test')", [tenant]);
  await pool.query("INSERT INTO users(id,tenant_id,email,name,password_hash,role) VALUES($1,$2,'test@example.test','test','unused','customer')", [user, tenant]);
  await pool.query("INSERT INTO tickets(id,tenant_id,customer_id,title,body) VALUES($1,$2,$3,'test','test')", [ticket, tenant, user]);
  await pool.query("INSERT INTO ticket_messages(id,tenant_id,ticket_id,author_id,role,body) VALUES($1,$2,$3,$4,'customer','test')", [message, tenant, ticket, user]);
  await pool.query("INSERT INTO ai_jobs(id,tenant_id,ticket_id,message_id,idempotency_key) VALUES($1,$2,$3,$4,'run-source-test')", [job, tenant, ticket, message]);
  await pool.query('INSERT INTO conversations(id,tenant_id,customer_id) VALUES($1,$2,$3)', [conv, tenant, user]);
  await pool.query("INSERT INTO conversation_messages(id,tenant_id,conversation_id,role,body) VALUES($1,$2,$3,'user','test')", [chatMessage, tenant, conv]);
  await pool.query('INSERT INTO ai_runs(id,tenant_id,ticket_id,job_id,message_id) VALUES($1,$2,$3,$4,$5)', [workerRun, tenant, ticket, job, message]);
  await pool.query('INSERT INTO ai_runs(id,tenant_id,conversation_id,message_id) VALUES($1,$2,$3,$4)', [sseRun, tenant, conv, chatMessage]);
  // An ambiguous historical source is legal under old target XOR. Reuse the
  // real worker row/job temporarily; do not fabricate a job or delete data.
  await pool.query('UPDATE ai_runs SET ticket_id=NULL,conversation_id=$2 WHERE id=$1', [workerRun, conv]);
  await assert.rejects(runMigrations(pool), /provenance needs explicit backfill/);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM ai_runs')).rows[0].n, 2);
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM support_migrations WHERE name LIKE '0013%'" )).rows[0].n, 0);
  console.log('Ambiguous existing source: migration rejected/rolled back; both rows retained; no fake jobs/backfill: PASS');
  // Restore the fixture's known original provenance, then inspect valid rows.
  await pool.query('UPDATE ai_runs SET ticket_id=$2,conversation_id=NULL WHERE id=$1', [workerRun, ticket]);
  console.log('Preflight source counts:', JSON.stringify((await pool.query("SELECT count(*) FILTER(WHERE job_id IS NOT NULL AND conversation_id IS NULL)::int AS worker,count(*) FILTER(WHERE job_id IS NULL AND conversation_id IS NOT NULL)::int AS sse FROM ai_runs")).rows[0]));
  await runMigrations(pool);
  const converted = randomUUID();
  await pool.query("INSERT INTO tickets(id,tenant_id,customer_id,title,body,conversation_id) VALUES($1,$2,$3,'converted','test',$4)", [converted, tenant, user, conv]);
  await pool.query('UPDATE ai_runs SET ticket_id=$2 WHERE id=$1', [sseRun, converted]);
  const { rows: [saved] } = await pool.query('SELECT id,ticket_id,conversation_id,job_id,message_id,pipeline_version FROM ai_runs WHERE id=$1', [sseRun]);
  assert.deepEqual(saved, { id: sseRun, ticket_id: converted, conversation_id: conv, job_id: null, message_id: chatMessage, pipeline_version: 'v1' });
  await assert.rejects(pool.query('UPDATE ai_runs SET conversation_id=NULL WHERE id=$1', [sseRun]), { code: '23514' });
  await assert.rejects(pool.query('UPDATE ai_runs SET conversation_id=$2 WHERE id=$1', [workerRun, conv]), { code: '23514' });
  await assert.rejects(pool.query('UPDATE ai_runs SET ticket_id=NULL WHERE id=$1', [workerRun]), { code: '23514' });
  await assert.rejects(pool.query('INSERT INTO ai_runs(tenant_id,conversation_id,message_id) VALUES($1,$2,$3)', [tenant, conv, chatMessage]), { code: '23505' });
  console.log('SSE same run id/conversation/message/pipeline retained + ticket added; source XOR/worker ticket/duplicate prevention: PASS');
  const constraints = (await pool.query("SELECT conname,pg_get_constraintdef(oid) AS definition FROM pg_constraint WHERE conrelid='ai_runs'::regclass AND conname IN('ai_runs_source','ai_runs_worker_ticket','ai_runs_check') ORDER BY conname")).rows;
  assert.equal(constraints.length, 2); console.log('Final constraints:', JSON.stringify(constraints));
} finally {
  await pool.end();
  if (created) {
    const { rows: [database] } = await admin.query("SELECT shobj_description(oid,'pg_database') AS owner FROM pg_database WHERE datname=$1", [name]); assert.equal(database.owner, owner);
    assert.equal((await admin.query('SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname=$1', [name])).rows[0].n, 0);
    await admin.query(`DROP DATABASE "${name}"`); console.log(`Dropped only owned DB ${name}`);
  }
  await admin.end();
}
