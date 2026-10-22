/**
 * 큐 워커 ↔ AI 파이프라인 어댑터(워커 전용, Node-safe: Next·server-only import 없음).
 * 실제 @support/ai processInquiry를 부르고 결과(AIRunResult)를 @support/queue 결과 형식으로 바꾼다.
 * 저장(ai_runs·ai_drafts·자동답변 메시지·이관 필드)은 큐 complete()가 티켓 행 잠금 후 다시 확인하며 한다.
 * deps.ts·worker-bootstrap.ts를 import하지 않는다(원형 import 방지).
 */
import { maskDeep, processInquiry, type AIRunResult, type PipelineDeps } from '@support/ai';
import { ProcessorFailure, type AIRunResult as QueueRunResult, type Inquiry, type ProcessInquiry } from '@support/queue';

export interface QueueAdapterDeps {
  pipeline: PipelineDeps;
  /** 재생성 작업은 messageId가 없다 → 티켓의 마지막 공개 고객 메시지(tenant 범위) */
  latestCustomerMessageId(tenantId: string, ticketId: string): Promise<string | null>;
}

/** 재시도해 볼 만한 오류(일시적). 나머지 오류 코드는 즉시 최종 이관. */
const TRANSIENT = new Set(['PROVIDER_ERROR', 'INTERNAL']);

/**
 * AI 결정 → 큐 동작. 고객 노출(reply)은 auto_answer + customerVisible + 오류 없음일 때만.
 * 원본 결과는 개인정보 마스킹 후 aiResult로 보관(상담원 분석용), 평탄화 필드는 KPI·필터 SQL용.
 */
export function toQueueResult(input: Inquiry, raw: AIRunResult): QueueRunResult {
  if (raw.tenantId !== input.tenantId || raw.ticketId !== input.ticketId || raw.conversationId) {
    throw new ProcessorFailure('ai_identity_mismatch', undefined, true);
  }
  const sources = [...raw.sources, ...(raw.draft?.sources ?? [])];
  if (sources.some((s) => s.tenantId !== input.tenantId)) {
    // 다른 테넌트 근거는 JSON 안에도 저장하지 않는다
    throw new ProcessorFailure('tenant_source_mismatch', undefined, true);
  }
  const safe = maskDeep(raw);
  const reply = safe.decision === 'auto_answer' && safe.draft?.customerVisible === true && safe.error === null;
  const result: QueueRunResult = {
    aiResult: safe,
    body: safe.draft?.body ?? '',
    action: reply ? 'reply' : 'draft',
    decision: safe.decision,
    reason: safe.reason,
    category: safe.classification?.category ?? null,
    urgency: safe.classification?.urgency ?? null,
    sentiment: safe.classification?.sentiment ?? null,
    confidence: safe.confidence.final,
    sources: safe.sources,
    model: safe.draft?.model ?? safe.usage.at(-1)?.model ?? null,
    inputTokens: safe.usage.reduce((s, u) => s + u.inputTokens, 0),
    outputTokens: safe.usage.reduce((s, u) => s + u.outputTokens, 0),
    latencyMs: Math.round(safe.timing.totalMs),
    error: safe.error?.code ?? null,
    pipelineVersion: safe.pipelineVersion,
    messageId: safe.messageId,
  };
  if (safe.error) {
    // 일시 오류는 큐가 재시도, 설정 오류(CONFIG_ERROR) 등은 바로 최종 이관(reason은 결과의 ai_error 유지)
    throw new ProcessorFailure(`ai_${safe.error.code.toLowerCase()}`, result, !TRANSIENT.has(safe.error.code));
  }
  return result;
}

/** 워커는 티켓 작업만 처리한다(대화는 SSE 전용, 대화에서 전환된 티켓은 작업이 없다). */
export function createQueueProcessor(deps: QueueAdapterDeps): ProcessInquiry {
  return async (job) => {
    if (!job.ticketId || job.conversationId) throw new ProcessorFailure('worker_ticket_only', undefined, true);
    const messageId = job.messageId ?? (await deps.latestCustomerMessageId(job.tenantId, job.ticketId));
    if (!messageId) throw new ProcessorFailure('inquiry_message_missing', undefined, true);
    const raw = await processInquiry({ tenantId: job.tenantId, ticketId: job.ticketId, messageId }, deps.pipeline);
    return toQueueResult(job, raw);
  };
}
