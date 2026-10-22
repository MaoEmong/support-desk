import assert from 'node:assert/strict';
import { test } from 'vitest';
import { runWorker, workerPollInterval } from '../src/worker.js';
import { WorkerStopping } from '../src/index.js';

test('worker validates poll bounds and defaults', () => {
  assert.equal(workerPollInterval('1000'), 1000);
  assert.throws(() => workerPollInterval('0'));
  assert.throws(() => workerPollInterval('NaN'));
  assert.throws(() => workerPollInterval('60001'));
});

test('already stopped worker never claims', async () => {
  const stop = new AbortController();
  stop.abort();
  let claims = 0;
  await runWorker({ signal: stop.signal, queue: { runOnce: async () => { claims++; return false; } } });
  assert.equal(claims, 0);
});

test('worker survives an iteration failure, reports only a generic code and stops', async () => {
  const stop = new AbortController();
  let calls = 0;
  const codes: string[] = [];
  await runWorker({ signal: stop.signal, pollIntervalMs: 10, onError: code => codes.push(code), queue: {
    runOnce: async () => {
      calls++;
      if (calls === 1) throw new Error('private provider payload');
      stop.abort();
      return false;
    },
  } });
  assert.equal(calls, 2);
  assert.deepEqual(codes, ['queue_iteration_failed']);
});

test('worker forwards the same shutdown signal to the active queue invocation', async () => {
  const stop = new AbortController();
  let notifyStarted!: () => void;
  const started = new Promise<void>(resolve => { notifyStarted = resolve; });
  let calls = 0;
  const active = runWorker({ signal: stop.signal, queue: {
    runOnce: async options => {
      calls++;
      assert.equal(options?.signal, stop.signal);
      notifyStarted();
      return new Promise<boolean>((_, reject) => {
        options!.signal!.addEventListener('abort', () => reject(new WorkerStopping()), { once: true });
      });
    },
  } });
  await started;
  stop.abort();
  await active;
  assert.equal(calls, 1);
});
