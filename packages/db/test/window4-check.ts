import assert from 'node:assert/strict';
import { config, parse } from 'dotenv';
import { Pool } from 'pg';
import { randomUUID } from 'node:crypto';
import { readFileSync, mkdirSync, writeFileSync, createWriteStream } from 'node:fs';
import { spawn, execFileSync, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { runMigrations } from '../src/migrations';
import { runHttpChecks, until } from './window1-http';
import { snapshotOwned, verifyStopped, type OwnedSnapshot } from './owned-process-check';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const directory = `${root}docs/verification/stage2/window4/`;
mkdirSync(directory, { recursive: true });
config({ path: `${root}.env`, quiet: true });
const target = new URL(process.env.DATABASE_URL ?? parse(readFileSync(`${root}.env.example`)).DATABASE_URL);
if (!process.env.DATABASE_URL) target.port = '55432';
assert(['localhost', '127.0.0.1', '[::1]'].includes(target.hostname));
const name = `support_window4_${Date.now()}_e2e`;
assert(/^support_window4_[0-9]+_e2e$/.test(name));
const owner = `window4:${randomUUID()}`;
const maintenance = new URL(target); maintenance.pathname = '/postgres'; target.pathname = `/${name}`;
const admin = new Pool({ connectionString: maintenance.toString(), max: 1 });
const pool = new Pool({ connectionString: target.toString(), max: 4 });
const cli = process.env.npm_execpath ?? process.env.WINDOW1_PNPM_CLI; assert(cli);
const env = { ...process.env, DATABASE_URL: target.toString(), TEST_DATABASE_URL: target.toString(), QUEUE_DATABASE_URL: target.toString(), AI_MODE: 'mock', WORKER_POLL_INTERVAL_MS: '500', APP_URL: 'http://127.0.0.1:3200', APP_ORIGINS: 'http://127.0.0.1:3200', NEXT_TELEMETRY_DISABLED: '1' };
const records: unknown[] = [];
function record(value: unknown) { records.push(value); console.log(JSON.stringify(value)); writeFileSync(`${directory}runtime-results.json`, JSON.stringify({ database: name, records }, null, 2)); }
async function command(args: string[], label: string) {
  const output = createWriteStream(`${directory}${label}.log`);
  const child = spawn(process.execPath, [cli!, ...args], { cwd: root, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout!.pipe(output, { end: false }); child.stderr!.pipe(output, { end: false });
  const exit = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', resolve); });
  await new Promise<void>(resolve => output.end(resolve));
  record({ command: `pnpm ${args.join(' ')}`, exit }); assert.equal(exit, 0, label);
}
let created = false, dev: ChildProcess | undefined, snapshot: OwnedSnapshot | undefined;
try {
  await admin.query(`CREATE DATABASE "${name}"`); created = true;
  await admin.query(`COMMENT ON DATABASE "${name}" IS '${owner}'`);
  await runMigrations(pool);
  execFileSync(process.execPath, [fileURLToPath(new URL('../node_modules/tsx/dist/cli.mjs', import.meta.url)), fileURLToPath(new URL('../src/seed.ts', import.meta.url))], { cwd: root, env, stdio: 'inherit' });
  const migrations = (await pool.query('SELECT name FROM support_migrations ORDER BY name')).rows.map(row => row.name);
  assert.equal(migrations.length, 14);
  record({ phase: 'fresh_migrate_seed', migrations, users: (await pool.query('SELECT role,count(*)::int AS count FROM users GROUP BY role ORDER BY role')).rows });
  await command(['test'], 'test-final');
  await command(['typecheck'], 'typecheck-after-fixes');
  await command(['lint'], 'lint-final');
  const output = createWriteStream(`${directory}root-dev-final.log`);
  dev = spawn(process.execPath, [cli, '-w', 'dev', '--port', '3200', '--hostname', '127.0.0.1'], { cwd: `${root}apps/web`, env, windowsHide: true, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] });
  dev.stdout!.pipe(output, { end: false }); dev.stderr!.pipe(output, { end: false });
  dev.once('exit', (exit, signal) => { output.end(); record({ phase: 'dev_exit', exit, signal, osSigtermVerified: false }); });
  const base = 'http://127.0.0.1:3200';
  await until(async () => { if (dev!.exitCode !== null) throw new Error('root dev exited'); try { return (await fetch(`${base}/api/t/pixelforge/settings/public`, { signal: AbortSignal.timeout(10000) })).status === 200 ? true : undefined; } catch { return undefined; } }, 'final root dev readiness', 90000);
  snapshot = snapshotOwned(dev.pid!, 3200); assert(snapshot.listeners.length > 0);
  assert(snapshot.processes.some(process => process.role === 'queue-worker-entry'));
  record({ phase: 'owned_runtime', ...snapshot });
  await runHttpChecks(base, pool, record);
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
