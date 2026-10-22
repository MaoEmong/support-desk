/**
 * 독립 AI 워커 조립 모듈. @support/queue worker-entry가 WORKER_BOOTSTRAP_MODULE(fileURL)로 동적 import해
 * createWorkerDependencies()를 한 번 호출한다.
 * - Node-safe: Next·server-only·라우트 코드를 import하지 않는다(@support/db·@support/ai·./deps·./queue-adapter만).
 * - 워커를 직접 띄우지 않는다(루프·SIGTERM·lease는 큐 담당).
 * - web(SSE)과 같은 deps를 쓴다: 공개 KB 캐시(+revision), 캐시 없는 설정 리더, tenant 범위 문의 리더.
 */
import { createProvider, loadAIConfig, type PipelineLogger } from '@support/ai';
import { db, pool } from '@support/db';
import type { Database, ProcessInquiry } from '@support/queue';
import { createPipelineDeps, createSettingsReader, latestCustomerMessageId } from './deps';
import { createQueueProcessor } from './queue-adapter';

export interface WorkerDependencies {
  db: Database;
  processInquiry: ProcessInquiry;
  close?: () => Promise<void>;
}

/** 운영 로그: 코드·식별자만(원문·개인정보 금지) */
const logger: PipelineLogger = {
  info: (msg, meta) => console.info(msg, pick(meta)),
  warn: (msg, meta) => console.warn(msg, pick(meta)),
  error: (msg, meta) => console.error(msg, pick(meta)),
};
function pick(meta?: Record<string, unknown>) {
  if (!meta) return {};
  const { tenantId, code } = meta;
  return { ...(tenantId !== undefined ? { tenantId } : {}), ...(code !== undefined ? { code } : {}) };
}

export async function createWorkerDependencies(): Promise<WorkerDependencies> {
  // AI_MODE 기본 mock(claude는 키가 있을 때만 명시적으로)
  const provider = createProvider(loadAIConfig({ ...process.env, AI_MODE: process.env.AI_MODE ?? 'mock' }));
  const pipeline = createPipelineDeps({ db, provider, settings: createSettingsReader(db), logger });
  const processInquiry = createQueueProcessor({
    pipeline,
    latestCustomerMessageId: (tenantId, ticketId) => latestCustomerMessageId(db, tenantId, ticketId),
  });
  return { db, processInquiry, close: () => pool.end() };
}
