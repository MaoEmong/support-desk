import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { InquiryQueue } from './index.js';
import { runWorker, workerPollInterval } from './worker.js';
import type { WorkerDependencies } from './worker.js';

/** Composition module is owned by the API team. Its factory must be Node-safe,
 * with no Next/server-only import, and must not start a second worker. */
async function main(): Promise<void> {
  const pollIntervalMs = workerPollInterval();
  const modulePath = process.env.WORKER_BOOTSTRAP_MODULE;
  if (!modulePath) throw new Error('WORKER_BOOTSTRAP_MODULE_required');
  const moduleUrl = modulePath.startsWith('file:') ? modulePath : pathToFileURL(resolve(modulePath)).href;
  const bootstrap = await import(moduleUrl) as { createWorkerDependencies?: () => Promise<WorkerDependencies> };
  // The composition module may load .env. Apply a default only afterward.
  process.env.AI_MODE ??= 'mock';
  if (typeof bootstrap.createWorkerDependencies !== 'function') throw new Error('worker_bootstrap_factory_required');
  const controller = new AbortController();
  const stop = () => controller.abort();
  process.once('SIGTERM', stop);
  process.once('SIGINT', stop);
  let deps: WorkerDependencies | undefined;
  try {
    deps = await bootstrap.createWorkerDependencies();
    const queue = new InquiryQueue(deps.db, deps.processInquiry);
    await runWorker({ queue, signal: controller.signal, pollIntervalMs, onError: code => console.error(code) });
  } finally {
    process.removeListener('SIGTERM', stop);
    process.removeListener('SIGINT', stop);
    await deps?.close?.();
  }
}

// On shutdown the active inference is discarded and its durable lease expires;
// a restarted process recovers it. Never release ownership before fencing output.
void main().catch(() => { console.error('worker_start_or_shutdown_failed'); process.exitCode = 1; });
