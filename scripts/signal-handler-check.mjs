import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import process from 'node:process';
import { setTimeout } from 'node:timers';
import console from 'node:console';
import { supervise, stopChild } from './processes.mjs';

// Unit injection exercises the actual registered handler. This does NOT prove
// Windows delivers an OS SIGTERM to a running Node process.
const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore', windowsHide: true, detached: process.platform !== 'win32' });
const pid = child.pid;
let injected = false;
try {
  const supervised = supervise([child]);
  setTimeout(() => { injected = true; process.emit('SIGTERM'); }, 100);
  await supervised;
  assert(injected);
  assert(child.exitCode !== null || child.signalCode !== null);
  let stillAlive = true;
  try { process.kill(pid, 0); } catch { stillAlive = false; }
  assert.equal(stillAlive, false);
  console.log(JSON.stringify({ check: 'SIGTERM handler injection unit', injected, childPid: pid, childExited: true, supervisorObservedExitCode: process.exitCode, osSignalDeliveryVerified: false }));
  // Intentional taskkill termination on Windows is a nonzero child status;
  // this check reports it rather than treating it as graceful OS delivery.
  process.exitCode = 0;
} finally { await stopChild(child); }
