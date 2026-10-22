import assert from 'node:assert/strict';
import { config, parse } from 'dotenv';
import { Pool } from 'pg';
import { randomUUID } from 'node:crypto';
import { readFileSync, mkdirSync, writeFileSync, createWriteStream } from 'node:fs';
import { spawn, execFileSync, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import { fileURLToPath } from 'node:url';
import { runMigrations } from '../src/migrations';
import { extraHttp } from './task579-http';
import { abortChecks } from './sse-complete-abort';
import { until } from './window1-http';
import { snapshotOwned, verifyStopped, type OwnedSnapshot } from './owned-process-check';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const directory = `${root}docs/verification/stage2/task584/`;
mkdirSync(directory, { recursive: true });
config({ path: `${root}.env`, quiet: true });
const target = new URL(process.env.DATABASE_URL ?? parse(readFileSync(`${root}.env.example`)).DATABASE_URL);
if (!process.env.DATABASE_URL) target.port = '55432';
assert(['localhost', '127.0.0.1', '[::1]'].includes(target.hostname));
const name = `support_sse584_${Date.now()}_e2e`; assert(/^support_sse584_[0-9]+_e2e$/.test(name));
const owner = `sse-complete:${randomUUID()}`;
const maintenance = new URL(target); maintenance.pathname = '/postgres'; target.pathname = `/${name}`;
const admin = new Pool({ connectionString: maintenance.toString(), max: 1 });
const pool = new Pool({ connectionString: target.toString(), max: 4 });
const cli = process.env.npm_execpath ?? process.env.WINDOW1_PNPM_CLI; assert(cli);
assert.notEqual(process.env.TASK579_HTTP_REMAINING, '1', 'Full SSE execution cannot skip any SSE checks');
const env = { ...process.env, DATABASE_URL: target.toString(), AI_MODE: 'mock', WORKER_POLL_INTERVAL_MS: '500', APP_URL: 'http://127.0.0.1:3200', APP_ORIGINS: 'http://127.0.0.1:3200', NEXT_TELEMETRY_DISABLED: '1', npm_config_verify_deps_before_run: 'false' };
const results: unknown[] = [];
const record = (value: unknown) => { results.push(value); console.log(JSON.stringify(value)); writeFileSync(`${directory}results.json`, JSON.stringify({ database: name, execution: 'one complete SSE execution; no prior pass mixing', results }, null, 2)); };
let created = false, dev: ChildProcess | undefined, snapshot: OwnedSnapshot | undefined;
try {
  await admin.query(`CREATE DATABASE "${name}"`); created = true;
  await admin.query(`COMMENT ON DATABASE "${name}" IS '${owner}'`);
  record({ phase: 'start', database: name });
  await runMigrations(pool);
  execFileSync(process.execPath, [fileURLToPath(new URL('../node_modules/tsx/dist/cli.mjs', import.meta.url)), fileURLToPath(new URL('../src/seed.ts', import.meta.url))], { cwd: root, env, stdio: 'inherit' });
  const probe = createServer(); await new Promise<void>((resolve, reject) => { probe.once('error', reject); probe.listen(3200, '127.0.0.1', resolve); }); await new Promise<void>(resolve => probe.close(() => resolve()));
  const log = createWriteStream(`${directory}root-dev.log`);
  dev = spawn(process.execPath, [cli, '--config.verify-deps-before-run=false', '-w', 'dev', '--port', '3200', '--hostname', '127.0.0.1'], { cwd: `${root}apps/web`, env, windowsHide: true, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] });
  dev.stdout!.pipe(log, { end: false }); dev.stderr!.pipe(log, { end: false }); dev.once('exit', (exit, signal) => { log.end(); record({ phase: 'dev_exit', pid: dev!.pid, exit, signal, mechanism: 'owned tree cleanup, not OS SIGTERM handler proof' }); });
  const base = 'http://127.0.0.1:3200';
  await until(async () => { if (dev!.exitCode !== null) throw new Error('SSE root dev exited'); try { return (await fetch(`${base}/api/t/pixelforge/settings/public`, { signal: AbortSignal.timeout(10000) })).status === 200 ? true : undefined; } catch { return undefined; } }, 'full SSE root dev', 90000);
  snapshot = snapshotOwned(dev.pid!, 3200);
  assert(snapshot.listeners.length > 0); assert(snapshot.listeners.every(id => snapshot!.processes.some(item => item.pid === id)));
  record({ phase: 'owned_processes', ...snapshot });
  await extraHttp(base, pool, record, { sseOnly: true });
  await abortChecks(base, pool, record);
  for (const check of ['forbidden_click_conversion', 'approval_auto_conversion', 'real_heartbeat_comment', 'staff_public_sources_example', 'same_run_abort_before_commit', 'same_run_abort_after_commit']) {
    assert(results.some(result => (result as { check?: string }).check === check), `Missing same-execution check ${check}`);
  }
  record({ phase: 'SSE_ALL_ASSERTS_PASSED', priorPassesUsed: false });
} finally {
  if (dev) { const { stopChild } = await import('../../../scripts/processes.mjs'); await stopChild(dev); }
  if (snapshot) record({ phase: 'runtime_cleanup', ...verifyStopped(snapshot, 3200) });
  await pool.end();
  if (created) {
    assert.equal((await admin.query("SELECT shobj_description(oid,'pg_database') AS owner FROM pg_database WHERE datname=$1", [name])).rows[0].owner, owner);
    assert.equal((await admin.query('SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname=$1', [name])).rows[0].n, 0);
    await admin.query(`DROP DATABASE "${name}"`); record({ phase: 'database_cleanup', name, activeConnections: 0, droppedOnlyOwned: true });
  }
  await admin.end();
}
