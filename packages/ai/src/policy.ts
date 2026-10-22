/**
 * 정책 판단: 자동답변 / 이관 / 승인 대기.
 * 순서가 곧 우선순위다. 금지 카테고리·인젝션 같은 하드룰은 확신도와 무관하게 먼저 적용한다.
 */
import type { ConfidenceBreakdown, Decision, DecisionReason, TenantAISettings } from './contracts';

/** 결합 가중치: LLM 자기보고는 단독으로 믿지 않는다. */
export const CONFIDENCE_WEIGHTS = { llm: 0.45, retrieval: 0.35, rule: 0.2 } as const;
/** 근거로 인정하는 최소 검색 점수(정규화 커버리지) */
export const MIN_SOURCE_SCORE = 0.2;

export function combineConfidence(parts: { llm: number; retrieval: number; rule: number }): ConfidenceBreakdown {
  const clamp = (n: number) => Math.max(0, Math.min(1, n));
  const llm = clamp(parts.llm);
  const retrieval = clamp(parts.retrieval);
  const rule = clamp(parts.rule);
  const final = clamp(CONFIDENCE_WEIGHTS.llm * llm + CONFIDENCE_WEIGHTS.retrieval * retrieval + CONFIDENCE_WEIGHTS.rule * rule);
  return { final: Math.round(final * 1000) / 1000, llm, retrieval, rule };
}

export interface PolicyInput {
  settings: TenantAISettings;
  category: string;
  forbiddenKeywordCategories: string[];
  injectionSuspected: boolean;
  suspiciousLinks: string[];
  autoAnswerCount: number;
  topSourceScore: number;
  confidence: ConfidenceBreakdown;
}

export interface PolicyDecision {
  decision: Decision;
  reason: DecisionReason;
  detail: string;
}

export function decide(p: PolicyInput): PolicyDecision {
  const { settings } = p;
  const forbidden = new Set(settings.forbiddenCategories);

  if (forbidden.has(p.category)) {
    return { decision: 'escalate', reason: 'forbidden_category', detail: `금지 카테고리(${p.category})로 분류되어 상담원 처리` };
  }
  if (p.forbiddenKeywordCategories.length > 0) {
    return {
      decision: 'escalate',
      reason: 'forbidden_category',
      detail: `금지 카테고리 키워드 감지(${p.forbiddenKeywordCategories.join(', ')}) — 분류(${p.category})와 무관하게 상담원 처리`,
    };
  }
  if (p.injectionSuspected) {
    return { decision: 'escalate', reason: 'injection_suspected', detail: '프롬프트 인젝션 의심 문구 포함' };
  }
  if (p.suspiciousLinks.length > 0) {
    return { decision: 'escalate', reason: 'suspicious_link', detail: `허용되지 않은 링크 포함: ${p.suspiciousLinks.join(', ')}` };
  }
  if (p.autoAnswerCount >= settings.autoAnswerLimit) {
    return {
      decision: 'escalate',
      reason: 'auto_answer_limit',
      detail: `이 문의에서 자동답변 ${p.autoAnswerCount}회 발생(한도 ${settings.autoAnswerLimit}) — 이후는 상담원 처리`,
    };
  }
  if (p.category === settings.fallbackCategory) {
    return { decision: 'escalate', reason: 'low_confidence', detail: `분류 불가(${p.category})` };
  }
  if (p.topSourceScore < MIN_SOURCE_SCORE) {
    return { decision: 'escalate', reason: 'no_sources', detail: `근거 문서 부족(최고 점수 ${p.topSourceScore.toFixed(2)})` };
  }
  if (p.confidence.final < settings.threshold) {
    return {
      decision: 'escalate',
      reason: 'low_confidence',
      detail: `결합 확신도 ${p.confidence.final.toFixed(2)} < 임계값 ${settings.threshold.toFixed(2)}`,
    };
  }
  if (settings.approvalMode) {
    return { decision: 'pending_approval', reason: 'approval_mode', detail: '승인 모드: 상담원 승인 후 고객에게 노출' };
  }
  return {
    decision: 'auto_answer',
    reason: 'confident_kb_match',
    detail: `결합 확신도 ${p.confidence.final.toFixed(2)} ≥ 임계값 ${settings.threshold.toFixed(2)}`,
  };
}

/** 고객에게 보여줄 안내 문구(이관 사유는 노출하지 않는다). */
export function customerNotice(decision: 'escalate' | 'pending_approval'): string {
  return decision === 'pending_approval'
    ? '답변을 준비했어요. 상담원 확인을 거쳐 곧 전달드릴게요.'
    : '문의 내용을 담당 상담원에게 전달했어요. 확인 후 답변드릴게요.';
}
