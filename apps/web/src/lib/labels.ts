import { customerTicketStatusLabels, type DecisionReason, type NoticeCodeSchema } from '@support/contracts';
import type { z } from 'zod';
import type { Tone } from '@/components/ui/surface';
import type { CustomerStatus, Role, TicketStatus } from './types';

/** contracts의 안내 코드 enum(NoticeCodeSchema). 값이 추가되면 noticeCopy에서 타입 오류가 난다. */
type NoticeCode = z.infer<typeof NoticeCodeSchema>;

/** 상담원 화면용 상태(계약 매핑 재사용) */
export const ticketStatusLabel: Record<TicketStatus, string> = customerTicketStatusLabels;
export const ticketStatusTone: Record<TicketStatus, Tone> = { open: 'info', in_progress: 'warning', resolved: 'success', closed: 'neutral' };

/** 고객 표시 상태(서버 customerStatus) */
export const customerStatusLabel: Record<CustomerStatus, string> = {
  received: '접수됨',
  answered: '답변 도착',
  in_progress: '처리 중',
  resolved: '해결됨',
  closed: '종료됨',
};
export const customerStatusTone: Record<CustomerStatus, Tone> = { received: 'info', answered: 'brand', in_progress: 'warning', resolved: 'success', closed: 'neutral' };

/**
 * AI 정책 판단 사유(@support/contracts가 re-export하는 AI DecisionReason) 한국어 라벨.
 * Record라서 enum에 사유가 추가되면 여기서 타입 오류가 난다. 고객·상담원 화면 공용이라 내부 용어는 피했다.
 */
export const decisionReasonLabel: Record<DecisionReason, string> = {
  confident_kb_match: '지식베이스 근거로 자동 답변',
  approval_mode: '상담원 확인 후 답변(승인 모드)',
  forbidden_category: '상담원 전용 문의 유형',
  injection_suspected: '의심스러운 지시 문구 포함',
  suspicious_link: '허용되지 않은 링크 포함',
  low_confidence: '자동 답변 신뢰도 부족',
  no_sources: '참고할 문서 없음',
  auto_answer_limit: '자동 답변 횟수 초과',
  unsafe_output: '답변 안전 검사 미통과',
  provider_refusal: 'AI가 답변하지 않음',
  ai_error: 'AI 처리 오류',
};

/** 서버가 보낸 사유 문자열 → 라벨. enum 밖 값(1단계 스텁의 ai_not_connected 등)·빈 값은 null */
export const decisionReasonText = (reason: string | null | undefined): string | null =>
  reason && Object.hasOwn(decisionReasonLabel, reason) ? decisionReasonLabel[reason as DecisionReason] : null;

/**
 * 챗봇 이관·실패 안내 문구. 대화 복원 system 메시지의 noticeCode가 1순위이고,
 * Record라서 코드가 추가되면 타입 오류가 난다. retry: 다시 보내기 버튼을 보여줄지.
 */
export const noticeCopy: Record<NoticeCode, { title: string; detail?: string; tone: 'info' | 'danger'; retry?: boolean }> = {
  APPROVAL_REQUIRED: { title: '상담원 확인 후 답변드립니다', detail: '이 고객센터는 모든 답변을 상담원이 확인한 뒤 보내 드립니다.', tone: 'info' },
  ESCALATED: { title: '상담원 확인이 필요합니다', tone: 'info' },
  PROCESSING_FAILED: { title: '답변을 처리하지 못했습니다', detail: '잠시 후 다시 보내거나 문의글로 남겨 주세요.', tone: 'danger', retry: true },
};

export const roleLabel: Record<Role, string> = { customer: '고객', agent: '상담원', tenant_admin: '테넌트 관리자', platform_admin: '플랫폼 관리자' };

/** 분류값은 테넌트 설정(categories)에서 오므로 고정 번역 없이 원문을 보여준다. 긴급도·감정은 알려진 값만 색을 입힌다. */
export function urgencyTone(v: string | null): Tone {
  switch (v) {
    case 'critical':
    case 'urgent':
    case 'high':
      return 'danger';
    case 'medium':
    case 'normal':
      return 'warning';
    case 'low':
      return 'success';
    default:
      return 'neutral';
  }
}
export const urgencyLabel = (v: string | null) =>
  v ? ({ critical: '긴급', urgent: '긴급', high: '높음', medium: '보통', normal: '보통', low: '낮음' } as Record<string, string>)[v] ?? v : '미분류';

export function sentimentTone(v: string | null): Tone {
  switch (v) {
    case 'negative':
    case 'angry':
      return 'danger';
    case 'positive':
      return 'success';
    case 'neutral':
      return 'neutral';
    default:
      return 'neutral';
  }
}
export const sentimentLabel = (v: string | null) =>
  v ? ({ negative: '부정', angry: '분노', neutral: '중립', positive: '긍정' } as Record<string, string>)[v] ?? v : '미분류';
