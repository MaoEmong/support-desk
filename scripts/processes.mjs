import { spawn, execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath, URL } from 'node:url';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import process from 'node:process';
import { config } from 'dotenv';

export const projectRoot = fileURLToPath(new URL('../', import.meta.url));
export function loadRootEnvironment() { config({ path: join(projectRoot, '.env') }); }
export function runtimeIdentity() {
  let database = 'unset';
  try { database = decodeURIComponent(new URL(process.env.DATABASE_URL).pathname.slice(1)); } catch { /* Never log a connection string. */ }
  return { pid: process.pid, parentPid: process.ppid, database, aiMode: process.env.AI_MODE ?? 'mock', pollIntervalMs: process.env.WORKER_POLL_INTERVAL_MS ?? '1000' };
}
export function launchPnpm(args, extraEnv = {}) {
  const cli = process.env.npm_execpath;
  if (!cli || !/\.(?:c|m)?js$/.test(cli) || !existsSync(cli)) throw new Error('Run this wrapper through pnpm dev or pnpm worker');
  // Invoke Node directly: no cmd.exe interpolation or shell-escaped user arguments.
  return spawn(process.execPath, [cli, ...args], { cwd: projectRoot, env: { ...process.env, ...extraEnv }, stdio: 'inherit', detached: process.platform !== 'win32', windowsHide: true });
}
const running = child => child.pid && child.exitCode === null && child.signalCode === null;
export async function stopChild(child) {
  if (!running(child)) return;
  const exited = new Promise(resolve => child.once('exit', resolve));
  if (process.platform === 'win32') {
    // Only a PID created by this wrapper and its descendants may be signalled.
    await new Promise(resolve => execFile('taskkill', ['/PID', String(child.pid), '/T'], { windowsHide: true }, () => resolve()));
  } else {
    try { process.kill(-child.pid, 'SIGTERM'); } catch { /* Already exited. */ }
  }
  await Promise.race([exited, delay(5000)]);
  if (!running(child)) return;
  if (process.platform === 'win32') {
    await new Promise(resolve => execFile('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true }, () => resolve()));
  } else {
    try { process.kill(-child.pid, 'SIGKILL'); } catch { /* Already exited. */ }
  }
  await Promise.race([exited, delay(1000)]);
}
export async function supervise(children) {
  let stopping;
  const stop = () => stopping ??= Promise.all(children.map(stopChild));
  const interrupt = () => { void stop(); };
  process.once('SIGINT', interrupt); process.once('SIGTERM', interrupt);
  try {
    const code = await Promise.race(children.map(child => new Promise(resolve => {
      child.once('error', () => resolve(1));
      child.once('exit', (exitCode, signal) => resolve(exitCode ?? (signal ? 0 : 1)));
    })));
    await stop();
    process.exitCode = code;
  } finally {
    process.removeListener('SIGINT', interrupt); process.removeListener('SIGTERM', interrupt);
  }
}
