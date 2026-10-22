import { customerNotice, PIPELINE_VERSION, streamInquiry, type AIRunResult, type PipelineDeps, type SSEEvent } from '@support/ai';

/**
 * 챗봇 응답기. @support/ai 내부 이벤트(SSEEvent: classified·sources·token·escalated·error·done{result})를 낸다.
 * 고객에게는 그대로 보내지 않는다: 라우트가 sse-public.ts로 공개 이벤트만 만들고, done.result는 서버가 저장한 뒤 IDs만 보낸다.
 * signal이 abort되면 응답기는 done 없이 끝나야 한다(부분 답변 저장 금지).
 */
export interface ChatInput {
  tenantId: string;
  conversationId: string;
  /** 방금 저장한 고객(user) 메시지 */
  messageId: string;
}

export interface ChatResponder {
  respond(input: ChatInput, signal: AbortSignal): AsyncIterable<SSEEvent>;
}

/** 실제 AI 파이프라인(streamInquiry). 정책 판단 전 token 금지·abort 시 provider 취소는 AI 패키지가 보장한다. */
export function createAiChatResponder(pipeline: PipelineDeps): ChatResponder {
  return {
    respond: (input, signal) =>
      streamInquiry({ tenantId: input.tenantId, conversationId: input.conversationId, messageId: input.messageId }, pipeline, { signal }),
  };
}

/** AI 미연동 스텁: 자동답변을 지어내지 않고 항상 상담원 이관 안내(reason ai_error). */
export const stubChatResponder: ChatResponder = {
  async *respond(input) {
    yield { type: 'classified', classification: { category: 'other', urgency: 'low', sentiment: 'neutral', confidence: 0 } };
    yield { type: 'escalated', decision: 'escalate', reason: 'ai_error', notice: customerNotice('escalate') };
    yield { type: 'done', result: escalatedResult(input, 'ai_error', 'AI 미연동 스텁') };
  },
};

/** 스텁·테스트용 최소 이관 결과(실제 결과는 파이프라인이 만든다). */
export function escalatedResult(input: ChatInput, reason: AIRunResult['reason'], detail: string): AIRunResult {
  return {
    pipelineVersion: PIPELINE_VERSION,
    tenantId: input.tenantId,
    conversationId: input.conversationId,
    messageId: input.messageId,
    decision: 'escalate',
    reason,
    reasonDetail: detail,
    classification: null,
    confidence: { final: 0, llm: 0, retrieval: 0, rule: 0 },
    sources: [],
    draft: null,
    usage: [],
    timing: { classifyMs: 0, retrieveMs: 0, generateMs: 0, totalMs: 0 },
    flags: { injectionSuspected: false, suspiciousLinks: [], removedOutputLinks: [] },
    error: null,
  };
}
