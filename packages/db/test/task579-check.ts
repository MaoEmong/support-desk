import assert from 'node:assert/strict';
import { config, parse } from 'dotenv';
import { Pool } from 'pg';
import { randomUUID } from 'node:crypto';
import { readFileSync, mkdirSync, writeFileSync, createWriteStream } from 'node:fs';
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import { fileURLToPath } from 'node:url';
import { extraHttp } from './task579-http';
import { HttpClient, until } from './window1-http';
import { snapshotOwned, verifyStopped, type OwnedSnapshot } from './owned-process-check';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const cwd = fileURLToPath(new URL('../../../apps/web/', import.meta.url));
const directory = `${root}docs/verification/stage2/task579/`;
mkdirSync(directory, { recursive: true });
config({ path: `${root}.env`, quiet: true });
const target = new URL(process.env.DATABASE_URL ?? parse(readFileSync(`${root}.env.example`)).DATABASE_URL);
if (!process.env.DATABASE_URL) target.port = '55432';
assert(['localhost', '127.0.0.1', '[::1]'].includes(target.hostname));
const name = `support_task579_${Date.now()}_e2e`;
assert(/^support_task579_[0-9]+_e2e$/.test(name));
const owner = `task579:${randomUUID()}`;
const maintenance = new URL(target); maintenance.pathname = '/postgres'; target.pathname = `/${name}`;
const admin = new Pool({ connectionString: maintenance.toString(), max: 1 });
let pool = new Pool({ connectionString: target.toString(), max: 4 });
let poolEnded = false;
const cli = process.env.npm_execpath ?? process.env.WINDOW1_PNPM_CLI; assert(cli);
const env = { ...process.env, DATABASE_URL: target.toString(), AI_MODE: 'mock', WORKER_POLL_INTERVAL_MS: '500', APP_URL: 'http://127.0.0.1:3200', APP_ORIGINS: 'http://127.0.0.1:3200', NEXT_TELEMETRY_DISABLED: '1', npm_config_verify_deps_before_run: 'false' };
const results: unknown[] = [];
const record = (value: unknown) => { results.push(value); console.log(JSON.stringify(value)); writeFileSync(`${directory}results.json`, JSON.stringify({ database: name, results }, null, 2)); };
const owned = new Set<ChildProcess>();
let ownedSnapshot: OwnedSnapshot | undefined;
function launch(args: string[], label: string) {
  const log = createWriteStream(`${directory}${label}.log`);
  const child = spawn(process.execPath, [cli!, ...args], { cwd, env, windowsHide: true, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout!.pipe(log, { end: false }); child.stderr!.pipe(log, { end: false });
  child.once('exit', (exit, signal) => { log.end(); record({ process: label, pid: child.pid, exit, signal }); });
  owned.add(child); return child;
}
async function command(args: string[], label: string, expected: number) {
  const child = launch(args, label);
  const code = await new Promise((resolve, reject) => { child.once('exit', resolve); child.once('error', reject); });
  owned.delete(child); assert.equal(code, expected, label);
}
let created = false;
try {
  await admin.query(`CREATE DATABASE "${name}"`); created = true;
  await admin.query(`COMMENT ON DATABASE "${name}" IS '${owner}'`);
  if (process.env.TASK579_SKIP_RESET_REFUSAL === '1') record({ check: 'reset_refusal_not_repeated', priorEvidence: 'attempt1/apps-web-cwd-reset-refusal.log', currentPassClaim: false });
  else {
  const held = await pool.connect(); await held.query('SELECT 1');
  try {
    await command(['--config.verify-deps-before-run=false', '-w', 'db:seed', '--reset'], 'apps-web-cwd-reset-refusal', 1);
    const refusal = readFileSync(`${directory}apps-web-cwd-reset-refusal.log`, 'utf8');
    assert(refusal.includes('target database has active connections'));
    assert.equal((await held.query('SELECT 1 AS n')).rows[0].n, 1);
    record({ check: 'apps_web_cwd_reset_active_connection_refused', expectedExit: 1, databasePreserved: true });
  } finally { held.release(); }
  }
  await pool.end(); poolEnded = true;
  await command(['--config.verify-deps-before-run=false', '-w', 'db:seed', '--reset'], 'apps-web-cwd-reset-seed', 0);
  // Explicit --reset recreated precisely this owned DB; reapply ownership mark.
  await admin.query(`COMMENT ON DATABASE "${name}" IS '${owner}'`);
  pool = new Pool({ connectionString: target.toString(), max: 4 });
  poolEnded = false;
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM support_migrations')).rows[0].n, 14);
  record({ check: 'apps_web_cwd_reset_seed', expectedExit: 0, migrations: 14, originalFrontendDatabaseTouched: false });
  const probe = createServer();
  await new Promise<void>((resolve, reject) => { probe.once('error', reject); probe.listen(3200, '127.0.0.1', resolve); });
  await new Promise<void>(resolve => probe.close(() => resolve()));
  const dev = launch(['--config.verify-deps-before-run=false', '-w', 'dev', '--port', '3200', '--hostname', '127.0.0.1'], 'apps-web-cwd-root-dev');
  const base = 'http://127.0.0.1:3200';
  await until(async () => { if (dev.exitCode !== null) throw new Error('root dev exited'); try { return (await fetch(`${base}/api/t/pixelforge/settings/public`, { signal: AbortSignal.timeout(10000) })).status === 200 ? true : undefined; } catch { return undefined; } }, 'apps/web cwd root dev', 90000);
  record({ check: 'apps_web_cwd_root_dev', cwd: 'apps/web', command: 'pnpm -w dev --port 3200 --hostname 127.0.0.1', port: 3200, database: name, aiMode: 'mock', pollIntervalMs: 500 });
  ownedSnapshot = snapshotOwned(dev.pid!, 3200);
  assert(ownedSnapshot.processes.some(process => process.role === 'queue-worker-entry'));
  assert(ownedSnapshot.listeners.length > 0);
  assert(ownedSnapshot.listeners.every(pid => ownedSnapshot!.processes.some(process => process.pid === pid)));
  record({ check: 'owned_runtime_pids', ...ownedSnapshot });
  let passwordToCheck: string;
  if (process.env.TASK579_MATRIX_ONLY === '1') {
    assert.equal(process.env.TASK579_AI_EVAL14_READY, '1', 'Explicit AI eval14 signal required');
    const { runMatrix } = await import('./task579-matrix');
    await runMatrix(base, pool, `${directory}demo-matrix.json`);
    // Close the previous run's audit/DTO vs actual-log evidence gap without
    // repeating the completed agents permission/atomicity suite.
    const client = new HttpClient(base); await client.login('pixelforge', 'admin');
    const created = await client.request('/t/pixelforge/admin/agents', 'POST', { name: 'Log safety probe', email: `log-${Date.now()}@example.test` });
    assert.equal(created.status, 201); passwordToCheck = created.json.temporaryPassword;
  } else passwordToCheck = (await extraHttp(base, pool, record)).temporaryPassword;
  const runtimeLog = readFileSync(`${directory}apps-web-cwd-root-dev.log`, 'utf8');
  assert(runtimeLog.includes('dev.runtime')); assert(runtimeLog.includes('worker.runtime')); assert(runtimeLog.includes(name));
  for (const prefix of ['dev.runtime ', 'worker.runtime ']) {
    const line = runtimeLog.split(/\r?\n/).find(line => line.startsWith(prefix)); assert(line);
    const effective = JSON.parse(line.slice(prefix.length));
    assert.equal(effective.database, name); assert.equal(effective.aiMode, 'mock'); assert.equal(effective.pollIntervalMs, '500');
    record({ check: prefix.trim(), ...effective });
  }
  assert(!runtimeLog.includes(passwordToCheck));
  record({ check: 'actual_server_log_password_leak', count: 0 });
  record({ check: 'runtime_env_identity', database: name, aiMode: 'mock', pollIntervalMs: '500', rootAndWorkerIdentityLogsPresent: true });
} finally {
  const { stopChild } = await import('../../../scripts/processes.mjs');
  for (const child of owned) { await stopChild(child); owned.delete(child); }
  if (ownedSnapshot) record({ check: 'owned_runtime_stopped', ...verifyStopped(ownedSnapshot, 3200) });
  if (!poolEnded) await pool.end();
  if (created) {
    const { rows: [database] } = await admin.query("SELECT shobj_description(oid,'pg_database') AS owner FROM pg_database WHERE datname=$1", [name]); assert.equal(database.owner, owner);
    assert.equal((await admin.query('SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname=$1', [name])).rows[0].n, 0);
    await admin.query(`DROP DATABASE "${name}"`); record({ cleanup: name, connections: 0, droppedOnlyOwned: true });
  }
  await admin.end();
}
