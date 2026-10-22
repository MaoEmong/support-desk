/**
 * 챗봇 SSE: @support/ai 내부 이벤트 → 고객 공개 이벤트({event, data}) 변환.
 * - 고객 출력에 AI formatSSE를 쓰지 않는다(내부 done.result 누출 방지). 직렬화는 contracts 공개 formatter.
 * - 화이트리스트로 필드를 새로 만든다: classified는 category만, sources는 {id,title,excerpt?,url?},
 *   escalated는 {reason, message}. confidence·urgency·sentiment·summary·score·tenantId·reasonDetail은 나가지 않는다.
 * - done(내부 result)은 여기서 바꾸지 않는다: 라우트가 저장한 뒤 IDs만 담은 공개 done을 따로 보낸다.
 * - token 게이트: classified 뒤 sources가 와서 자동답변이 확정된 경우에만 token을 통과시키고,
 *   escalated·error 이후나 승인 모드 테넌트에서는 버린다(AI 패키지 순서 규약의 서버 이중 방어).
 */
import type { DecisionReason, SSEEvent as AISSEEvent } from '@support/ai';
import type { SSEEvent as PublicSSEEvent } from '@support/contracts';
import type { NoticeCode, PublicSource } from '../domain';
import { toPublicSources, type SourcePolicy } from '../public-sources';

/** 공개 이벤트는 contracts SSEEventSchema({event, data}) 그대로. 직렬화는 contracts formatPublicSSE만 쓴다 */
export type PublicSseEvent = PublicSSEEvent;

export const PROCESSING_FAILED_MESSAGE = '일시적인 문제로 답변을 만들지 못했어요. 문의글로 남겨 주시면 상담원이 답변드릴게요.';

export function noticeCodeFor(decision: 'escalate' | 'pending_approval' | 'error'): NoticeCode {
  return decision === 'pending_approval' ? 'APPROVAL_REQUIRED' : decision === 'error' ? 'PROCESSING_FAILED' : 'ESCALATED';
}

type Phase = 'start' | 'classified' | 'answering' | 'stopped';

/** 한 응답 스트림의 상태를 들고 내부 이벤트를 하나씩 공개 이벤트로 바꾼다. */
export class PublicSseMapper {
  private phase: Phase = 'start';
  /** 고객에게 실제로 내보낸 답변 텍스트(저장용) */
  answer = '';
  sources: PublicSource[] = [];
  escalation: { reason: DecisionReason; message: string } | null = null;
  failed = false;

  constructor(private readonly opts: { policy: SourcePolicy; conversationId: string; approvalMode: boolean }) {}

  map(ev: AISSEEvent): PublicSseEvent | null {
    switch (ev.type) {
      case 'classified':
        if (this.phase !== 'start') return null;
        this.phase = 'classified';
        return { event: 'classified', data: { category: ev.classification.category, conversationId: this.opts.conversationId } };
      case 'sources': {
        if (this.phase !== 'classified' || this.opts.approvalMode) return null;
        this.phase = 'answering';
        // 저장·응답과 같은 단일 정책: 다른 테넌트 항목 제외 → 공개 키 projection → https·허용 도메인 URL만
        this.sources = toPublicSources(ev.sources, this.opts.policy);
        return { event: 'sources', data: { sources: this.sources } };
      }
      case 'token':
        if (this.phase !== 'answering' || this.opts.approvalMode || !ev.text) return null;
        this.answer += ev.text;
        return { event: 'token', data: { token: ev.text } };
      case 'escalated':
        if (this.phase === 'stopped') return null;
        this.phase = 'stopped';
        this.escalation = { reason: ev.reason, message: ev.notice };
        return { event: 'escalated', data: { reason: ev.reason, message: ev.notice } };
      case 'error':
        if (this.phase === 'stopped' && this.escalation) {
          // 이미 이관 안내를 보냈으면 오류는 내부 기록만
          this.failed = true;
          return null;
        }
        this.phase = 'stopped';
        this.failed = true;
        return { event: 'error', data: { code: 'AI_UNAVAILABLE', message: PROCESSING_FAILED_MESSAGE } };
      case 'done':
        return null;
    }
  }
}
