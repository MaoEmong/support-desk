import assert from 'node:assert/strict';
import { config, parse } from 'dotenv';
import { Pool } from 'pg';
import { randomUUID } from 'node:crypto';
import { readFileSync, mkdirSync, createWriteStream, writeFileSync } from 'node:fs';
import { spawn, type ChildProcess, execFileSync } from 'node:child_process';
import { createServer } from 'node:net';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { getDemoCase } from '@support/ai/data';
import { runMigrations } from '../src/migrations';
import { runHttpChecks, until } from './window1-http';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const logDir = fileURLToPath(new URL('../../../docs/verification/stage2/window1/', import.meta.url));
mkdirSync(logDir, { recursive: true });
config({ path: `${root}.env`, quiet: true });
const example = parse(readFileSync(`${root}.env.example`));
const target = new URL(process.env.DATABASE_URL ?? example.DATABASE_URL);
if (!process.env.DATABASE_URL) target.port = '55432';
assert(['localhost', '127.0.0.1', '[::1]'].includes(target.hostname));
const name = `support_window1_${Date.now()}_e2e`;
assert(/^support_window1_[0-9]+_e2e$/.test(name));
const ownership = `window1-check:${randomUUID()}`;
const maintenance = new URL(target); maintenance.pathname = '/postgres';
target.pathname = `/${name}`;
const env = { ...process.env, DATABASE_URL: target.toString(), TEST_DATABASE_URL: target.toString(), QUEUE_DATABASE_URL: target.toString(), AI_MODE: 'mock', WORKER_POLL_INTERVAL_MS: '500', NEXT_TELEMETRY_DISABLED: '1', npm_config_verify_deps_before_run: 'false' };
// pnpm exec does not always supply npm_execpath (unlike pnpm run).
const cli = process.env.npm_execpath ?? process.env.WINDOW1_PNPM_CLI; assert(cli, 'Provide the installed pnpm JS CLI path; do not install another copy');
const records: unknown[] = [];
const record = (value: unknown) => { records.push(value); console.log(JSON.stringify(value)); writeFileSync(`${logDir}results.json`, JSON.stringify({ database: name, records }, null, 2)); };
const owned = new Set<ChildProcess>();
function launch(args: string[], label: string, extra: Record<string, string> = {}) {
  const log = createWriteStream(`${logDir}${label}.log`);
  const child = spawn(process.execPath, [cli!, ...args], { cwd: root, env: { ...env, ...extra }, windowsHide: true, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout!.pipe(log, { end: false }); child.stderr!.pipe(log, { end: false });
  child.once('exit', (code, signal) => { log.end(); record({ process: label, pid: child.pid, exit: code, signal }); });
  owned.add(child); return child;
}
async function stop(child: ChildProcess) {
  const { stopChild } = await import('../../../scripts/processes.mjs');
  await stopChild(child); owned.delete(child);
}
async function command(args: string[], label: string) {
  const child = launch(args, label);
  const code = await new Promise<number | null>((resolve, reject) => { child.once('exit', resolve); child.once('error', reject); });
  owned.delete(child); assert.equal(code, 0, `${label}; see ${label}.log`);
}
async function freePort() {
  const server = createServer();
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const port = (server.address() as { port: number }).port;
  assert.notEqual(port, 3000);
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  return port;
}
const admin = new Pool({ connectionString: maintenance.toString(), max: 1 });
const pool = new Pool({ connectionString: target.toString(), max: 2 });
let created = false;
try {
  await admin.query(`CREATE DATABASE "${name}"`); created = true;
  await admin.query(`COMMENT ON DATABASE "${name}" IS '${ownership}'`);
  record({ phase: 'new_owned_database', name, sharedDatabaseTouched: false });
  await runMigrations(pool);
  execFileSync(process.execPath, [fileURLToPath(new URL('../node_modules/tsx/dist/cli.mjs', import.meta.url)), fileURLToPath(new URL('../src/seed.ts', import.meta.url))], { cwd: root, env, stdio: 'inherit' });
  if (process.env.WINDOW1_SKIP_SCOPED === '1') record({ phase: 'scoped_tests_not_repeated', priorEvidence: 'attempt2/scoped-tests.log', priorPass: 45, currentPassClaim: false });
  else await command(['--config.verify-deps-before-run=false', 'exec', 'vitest', 'run', 'packages/queue/test', 'apps/web/src/server/__tests__/postgres.integration.test.ts', 'apps/web/src/server/__tests__/conversations.test.ts', 'packages/contracts/test/public.test.ts'], 'scoped-tests');
  // Capture an otherwise generic queue_iteration_failed stack in test-only code.
  process.env.DATABASE_URL = target.toString();
  const { createWorkerDependencies } = await import('../../../apps/web/src/server/ai/worker-bootstrap');
  const deps = await createWorkerDependencies();
  try {
    const { InquiryQueue } = await import('../../queue/src/index');
    await new InquiryQueue(deps.db, deps.processInquiry).claim();
    record({ phase: 'real_bootstrap_queue_claim', result: 'pass' });
  } catch (error) {
    writeFileSync(`${logDir}queue-preflight-error.log`, error instanceof Error ? `${error.stack}\nCause: ${JSON.stringify(error.cause)}` : String(error));
    throw error;
  } finally { await deps.close?.(); }
  const port = await freePort(); const base = `http://127.0.0.1:${port}`;
  const dev = launch(['--config.verify-deps-before-run=false', 'dev', '--port', String(port), '--hostname', '127.0.0.1'], 'dev', { APP_URL: base, APP_ORIGINS: base });
  await until(async () => { if (dev.exitCode !== null) throw new Error('dev exited before ready'); try { return (await fetch(`${base}/api/t/pixelforge/settings/public`, { signal: AbortSignal.timeout(10000) })).status === 200 ? true : undefined; } catch { return undefined; } }, 'root web+worker readiness', 90000);
  record({ phase: 'root_dev_ready', port, pid: dev.pid, database: name });
  await runHttpChecks(base, pool, record);
  await stop(dev);
  record({ phase: 'root_dev_stopped', platform: process.platform, shutdownMechanism: process.platform === 'win32' ? 'owned taskkill tree (OS SIGTERM handler delivery unverified)' : 'SIGTERM group' });
  await until(async () => { try { await fetch(`${base}/api/t/pixelforge/settings/public`); return undefined; } catch { return true; } }, 'dev port released');

  const demo = getDemoCase('pixelforge', 'faq_install');
  const { rows: [tenant] } = await pool.query("SELECT id FROM tenants WHERE slug='pixelforge'");
  const { rows: [customer] } = await pool.query("SELECT id FROM users WHERE tenant_id=$1 AND role='customer' LIMIT 1", [tenant.id]);
  async function newJob() {
    const ticket = randomUUID(), message = randomUUID(), job = randomUUID();
    const tx = await pool.connect();
    try {
      await tx.query('BEGIN');
      await tx.query('INSERT INTO tickets(id,tenant_id,customer_id,title,body) VALUES($1,$2,$3,$4,$5)', [ticket, tenant.id, customer.id, demo.title, demo.message]);
      await tx.query("INSERT INTO ticket_messages(id,tenant_id,ticket_id,author_id,role,author_type,body) VALUES($1,$2,$3,$4,'customer','customer',$5)", [message, tenant.id, ticket, customer.id, demo.message]);
      await tx.query('INSERT INTO ai_jobs(id,tenant_id,ticket_id,message_id,idempotency_key,max_attempts) VALUES($1,$2,$3,$4,$5,2)', [job, tenant.id, ticket, message, `window1:${job}`]);
      await tx.query('COMMIT'); return { ticket, message, job };
    } catch (error) { await tx.query('ROLLBACK'); throw error; } finally { tx.release(); }
  }
  const retry = await newJob(), lease = await newJob();
  await pool.query("UPDATE ai_jobs SET status='processing',attempts=1,lease_token=$2,lease_until=now()-interval '1 second' WHERE id=$1", [lease.job, randomUUID()]);
  const worker = launch(['--config.verify-deps-before-run=false', 'worker'], 'standalone-worker', { WORKER_BOOTSTRAP_MODULE: pathToFileURL(fileURLToPath(new URL('./window1-bootstrap.ts', import.meta.url))).href, WINDOW1_FAILURE_TICKET: retry.ticket });
  await until(async () => (await pool.query("SELECT id FROM ai_jobs WHERE id=$1 AND status='failed' AND attempts=2", [retry.job])).rows[0], 'transient retry exhaustion');
  await until(async () => (await pool.query("SELECT id FROM ai_jobs WHERE id=$1 AND status='succeeded' AND attempts=2", [lease.job])).rows[0], 'expired lease recovery');
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM ticket_messages WHERE source_job_id=$1", [lease.job])).rows[0].n, 1);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM ai_drafts WHERE job_id=$1', [retry.job])).rows[0].n, 0);
  assert((await pool.query('SELECT escalated_at FROM tickets WHERE id=$1', [retry.ticket])).rows[0].escalated_at);
  record({ phase: 'standalone_worker', retryJobId: retry.job, retryAttempts: 2, finalEscalated: true, emptyDraftCount: 0, recoveredLeaseJobId: lease.job, duplicateMessages: 0, faultInjection: 'test-only transient wrapper; real queue and default API processor for lease case' });
  await stop(worker);
  await command(['--config.verify-deps-before-run=false', '--filter', '@support/web', 'build'], 'production-build');
} finally {
  for (const child of owned) await stop(child);
  await pool.end();
  if (created) {
    const { rows: [database] } = await admin.query("SELECT shobj_description(oid,'pg_database') AS owner FROM pg_database WHERE datname=$1", [name]);
    assert.equal(database?.owner, ownership);
    const { rows: [activity] } = await admin.query('SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname=$1', [name]);
    assert.equal(activity.n, 0, 'Refuse DROP with target connections still active');
    await admin.query(`DROP DATABASE "${name}"`);
    record({ phase: 'owned_database_cleanup', name, connections: 0, dropped: true });
  }
  await admin.end();
}
