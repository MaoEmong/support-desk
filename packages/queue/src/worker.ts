import { setTimeout as delay } from 'node:timers/promises';
import { type Database, type ProcessInquiry, InquiryQueue, WorkerStopping } from './index.js';

/** API-owned composition injects its @support/ai adapter; no web/AI imports here. */
export interface WorkerDependencies {
  db: Database;
  processInquiry: ProcessInquiry;
  close?: () => Promise<void>;
}

export function workerPollInterval(value = process.env.WORKER_POLL_INTERVAL_MS): number {
  const interval = value === undefined ? 1000 : Number(value);
  if (!Number.isSafeInteger(interval) || interval < 10 || interval > 60_000) throw new Error('WORKER_POLL_INTERVAL_MS must be 10..60000');
  return interval;
}

export async function runWorker(options: {
  queue: Pick<InquiryQueue, 'runOnce'>;
  signal: AbortSignal;
  pollIntervalMs?: number;
  /** Receives only a generic code, never raw provider/customer errors. */
  onError?: (code: string) => void;
}): Promise<void> {
  const interval = workerPollInterval(String(options.pollIntervalMs ?? workerPollInterval()));
  while (!options.signal.aborted) {
    let handled = false;
    try { handled = await options.queue.runOnce({ signal: options.signal }); }
    catch (error) {
      if (error instanceof WorkerStopping || options.signal.aborted) break;
      options.onError?.('queue_iteration_failed');
    }
    if (!handled && !options.signal.aborted) {
      try { await delay(interval, undefined, { signal: options.signal }); }
      catch { if (!options.signal.aborted) throw new Error('worker_poll_failed'); }
    }
  }
}
