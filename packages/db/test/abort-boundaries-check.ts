import assert from 'node:assert/strict';
import { config, parse } from 'dotenv';
import { readFileSync, mkdirSync, createWriteStream, writeFileSync } from 'node:fs';
import { Pool } from 'pg';
import { randomUUID } from 'node:crypto';
import { spawn, execFileSync, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:net';
import { getDemoCase } from '@support/ai/data';
import { runMigrations } from '../src/migrations';
import { HttpClient, until } from './window1-http';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const directory = `${root}docs/verification/stage2/abort/`;
mkdirSync(directory, { recursive: true });
config({ path: `${root}.env`, quiet: true });
const target = new URL(process.env.DATABASE_URL ?? parse(readFileSync(`${root}.env.example`)).DATABASE_URL);
if (!process.env.DATABASE_URL) target.port = '55432';
assert(['localhost', '127.0.0.1', '[::1]'].includes(target.hostname));
const name = `support_abort_${Date.now()}_e2e`;
assert(/^support_abort_[0-9]+_e2e$/.test(name));
const maintenance = new URL(target); maintenance.pathname = '/postgres'; target.pathname = `/${name}`;
const owner = `abort-check:${randomUUID()}`;
const admin = new Pool({ connectionString: maintenance.toString(), max: 1 });
const pool = new Pool({ connectionString: target.toString(), max: 4 });
const env = { ...process.env, DATABASE_URL: target.toString(), TEST_DATABASE_URL: target.toString(), AI_MODE: 'mock', NEXT_TELEMETRY_DISABLED: '1', npm_config_verify_deps_before_run: 'false' };
const cli = process.env.npm_execpath ?? process.env.WINDOW1_PNPM_CLI; assert(cli);
const results: unknown[] = [];
function record(value: unknown) { results.push(value); console.log(JSON.stringify(value)); writeFileSync(`${directory}results.json`, JSON.stringify({ database: name, results }, null, 2)); }
let created = false, web: ChildProcess | undefined;
try {
  await admin.query(`CREATE DATABASE "${name}"`); created = true;
  await admin.query(`COMMENT ON DATABASE "${name}" IS '${owner}'`);
  await runMigrations(pool);
  execFileSync(process.execPath, [fileURLToPath(new URL('../node_modules/tsx/dist/cli.mjs', import.meta.url)), fileURLToPath(new URL('../src/seed.ts', import.meta.url))], { cwd: root, env, stdio: 'inherit' });
  const unitLog = createWriteStream(`${directory}api-tests.log`);
  const tests = spawn(process.execPath, [cli, '--config.verify-deps-before-run=false', 'exec', 'vitest', 'run', 'apps/web/src/server/__tests__/conversations.test.ts', '-t', 'abort 경계'], { cwd: root, env, windowsHide: true });
  tests.stdout.pipe(unitLog, { end: false }); tests.stderr.pipe(unitLog, { end: false });
  const exit = await new Promise(resolve => tests.once('exit', resolve)); unitLog.end();
  assert.equal(exit, 0); record({ phase: 'API_abort_targeted_tests', exit, nonMatchingTests: 'skipped by explicit name filter; not pass' });
  const portServer = createServer();
  await new Promise<void>(resolve => portServer.listen(0, '127.0.0.1', resolve));
  const port = (portServer.address() as { port: number }).port; assert.notEqual(port, 3000);
  await new Promise<void>(resolve => portServer.close(() => resolve()));
  const base = `http://127.0.0.1:${port}`;
  const log = createWriteStream(`${directory}dev-web.log`);
  web = spawn(process.execPath, [cli, '--config.verify-deps-before-run=false', 'dev:web', '--port', String(port), '--hostname', '127.0.0.1'], { cwd: root, env: { ...env, APP_URL: base, APP_ORIGINS: base }, windowsHide: true, detached: process.platform !== 'win32' });
  web.stdout!.pipe(log, { end: false }); web.stderr!.pipe(log, { end: false }); web.once('exit', () => log.end());
  await until(async () => { try { return (await fetch(`${base}/api/t/pixelforge/settings/public`, { signal: AbortSignal.timeout(10000) })).status === 200 ? true : undefined; } catch { return undefined; } }, 'abort HTTP web ready', 90000);
  const client = new HttpClient(base); await client.login('pixelforge', 'customer1');
  const demo = getDemoCase('pixelforge', 'faq_install');
  function request(signal: AbortSignal, conversationId?: string) {
    return fetch(`${base}/api/t/pixelforge/chat`, { method: 'POST', signal, headers: { origin: base, 'content-type': 'application/json', 'x-csrf-token': client.csrf, cookie: [...client.cookies].map(([key, value]) => `${key}=${value}`).join('; ') }, body: JSON.stringify({ body: demo.message, ...(conversationId ? { conversationId } : {}) }) });
  }
  async function counts(conversationId: string) {
    const { rows: [row] } = await pool.query("SELECT (SELECT count(*)::int FROM conversation_messages WHERE conversation_id=$1 AND role='user') AS customer,(SELECT count(*)::int FROM conversation_messages WHERE conversation_id=$1 AND role='assistant') AS assistant,(SELECT count(*)::int FROM ai_runs WHERE conversation_id=$1) AS runs,(SELECT count(*)::int FROM ai_drafts WHERE conversation_id=$1) AS drafts", [conversationId]);
    return row;
  }
  // Test-only DB trigger gates the real persistence transaction immediately
  // before ai_runs INSERT. No production env, endpoint or DI hook is added.
  await pool.query("CREATE FUNCTION abort_test_gate() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN PERFORM pg_advisory_xact_lock(573001); PERFORM pg_sleep(0.25); RETURN NEW; END $$; CREATE TRIGGER abort_test_gate BEFORE INSERT ON ai_runs FOR EACH ROW EXECUTE FUNCTION abort_test_gate()");
  const gate = await pool.connect();
  let beforeId = '';
  try {
    await gate.query('SELECT pg_advisory_lock(573001)');
    const control = new AbortController();
    const response = await request(control.signal); assert.equal(response.status, 200);
    const reader = response.body!.getReader();
    let text = '';
    while (!beforeId) { const chunk = await reader.read(); assert(!chunk.done); text += new TextDecoder().decode(chunk.value); beforeId = text.match(/"conversationId":"([a-f0-9-]+)"/)?.[1] ?? ''; }
    await until(async () => (await pool.query("SELECT count(*)::int AS n FROM pg_locks WHERE locktype='advisory' AND objid=573001 AND NOT granted")).rows[0].n > 0 ? true : undefined, 'real persistence transaction blocked before commit');
    control.abort(); await reader.cancel().catch(() => {});
    await gate.query('SELECT pg_advisory_unlock(573001)');
    await until(async () => (await pool.query("SELECT count(*)::int AS n FROM pg_locks WHERE locktype='advisory' AND objid=573001")).rows[0].n === 0 ? true : undefined, 'aborted persistence transaction rolled back');
    assert.deepEqual(await counts(beforeId), { customer: 1, assistant: 0, runs: 0, drafts: 0 });
    record({ boundary: 'abort_before_commit', conversationId: beforeId, ...(await counts(beforeId)), realHttp: true, realDbTransactionGate: true });
  } finally { await gate.query('SELECT pg_advisory_unlock(573001)'); gate.release(); }
  await pool.query('DROP TRIGGER abort_test_gate ON ai_runs; DROP FUNCTION abort_test_gate()');
  const control = new AbortController();
  const response = await request(control.signal); assert.equal(response.status, 200);
  const reader = response.body!.getReader(); let wire = '', afterId = '';
  while (!afterId) {
    const chunk = await reader.read(); assert(!chunk.done); wire += new TextDecoder().decode(chunk.value);
    const done = wire.match(/event: done\r?\ndata: ([^\r\n]+)/);
    if (done) afterId = JSON.parse(done[1]).conversationId;
  }
  // A public done is emitted only after the real persistence tx commits.
  control.abort(); await reader.cancel().catch(() => {});
  const committed = await counts(afterId);
  assert.deepEqual(committed, { customer: 1, assistant: 1, runs: 1, drafts: 0 });
  const originalIds = (await pool.query('SELECT id FROM conversation_messages WHERE conversation_id=$1', [afterId])).rows.map(row => row.id);
  const followUp = await client.request('/t/pixelforge/chat', 'POST', { conversationId: afterId, body: demo.message });
  assert.equal(followUp.status, 200);
  assert.equal((await counts(afterId)).assistant, 1);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM conversation_messages WHERE id=ANY($1::uuid[])', [originalIds])).rows[0].n, 2);
  record({ boundary: 'abort_after_commit', conversationId: afterId, committed, originalMessageIdsPreserved: true, additionalDuplicateAssistant: 0, sameConversationFollowUpStatus: 200, realHttp: true });
} finally {
  if (web) { const { stopChild } = await import('../../../scripts/processes.mjs'); await stopChild(web); }
  await pool.end();
  if (created) {
    const { rows: [database] } = await admin.query("SELECT shobj_description(oid,'pg_database') AS owner FROM pg_database WHERE datname=$1", [name]); assert.equal(database.owner, owner);
    assert.equal((await admin.query('SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname=$1', [name])).rows[0].n, 0);
    await admin.query(`DROP DATABASE "${name}"`); record({ cleanup: name, droppedOwnedDatabase: true, sharedDatabaseTouched: false });
  }
  await admin.end();
}
