/**
 * 규칙 기반 신호: 테넌트 설정의 카테고리 키워드로 계산한다.
 * - mock 분류기의 본체
 * - claude 모드에서도 "규칙 점수"와 금지 카테고리 하드룰로 쓴다(LLM 이 틀려도 금지 주제는 이관)
 * 업종 지식은 코드에 두지 않는다. 카테고리·키워드는 전부 테넌트 설정에서 온다.
 */
import type { Sentiment, TenantAISettings, Urgency } from './contracts';
import { compact, containsKeyword } from './text';

export interface KeywordScores {
  /** 카테고리별 일치 키워드 */
  hits: Map<string, string[]>;
  /** 일치 수가 가장 많은 카테고리(동점이면 설정 순서상 앞, 금지 카테고리 우선) */
  top: { category: string; count: number } | null;
}

export function scoreKeywords(settings: TenantAISettings, message: string): KeywordScores {
  const text = compact(message);
  const hits = new Map<string, string[]>();
  for (const cat of settings.categories) {
    const matched = cat.keywords.filter((k) => containsKeyword(text, k));
    if (matched.length > 0) hits.set(cat.id, matched);
  }
  const forbidden = new Set(settings.forbiddenCategories);
  let top: KeywordScores['top'] = null;
  for (const cat of settings.categories) {
    const count = hits.get(cat.id)?.length ?? 0;
    if (count === 0) continue;
    if (!top || count > top.count || (count === top.count && forbidden.has(cat.id) && !forbidden.has(top.category))) {
      top = { category: cat.id, count };
    }
  }
  return { hits, top };
}

/** 금지 카테고리 키워드가 하나라도 걸리면 해당 카테고리 목록을 돌려준다. */
export function forbiddenKeywordHits(settings: TenantAISettings, scores: KeywordScores): string[] {
  return settings.forbiddenCategories.filter((id) => (scores.hits.get(id)?.length ?? 0) > 0);
}

/** LLM 분류와 키워드 규칙의 일치도(0~1). */
export function ruleAgreement(scores: KeywordScores, llmCategory: string): number {
  if (!scores.top) return 0.5; // 규칙 신호 없음 → 중립
  if (scores.top.category === llmCategory) return 1;
  if ((scores.hits.get(llmCategory)?.length ?? 0) > 0) return 0.75; // 2순위로는 맞음
  return 0.2;
}

// ---------------------------------------------------------------------------
// 업종 무관 긴급도·감정 신호(mock 및 보정용)
// ---------------------------------------------------------------------------

const ANGRY = ['화나', '화가', '짜증', '어이없', '어이가없', '장난하', '최악', '열받', '미치겠', '뭐하는', '당장', '빨리', 'ㅡㅡ', '!!', '사기', '고소', '신고할거', '실망스럽'];
const NEGATIVE = ['안돼', '안되', '안 돼', '안 되', '안와', '안 와', '안들어', '안 들어', '못', '불편', '문제', '오류', '에러', '실패', '끊겨', '끊김', '멈춰', '사라졌', '없어졌', '모르는', '걱정'];
const POSITIVE = ['감사', '고마', '좋아요', '좋네요', '편하', '최고', '덕분'];
const CRITICAL = ['해킹', '도용', '털어', '털렸', '털림', '모르는사람', '다른사람이로그인', '지금도접속', '개인정보유출', '전체발송실패', '모든발송', '서비스중단', '결제가계속'];
const HIGH = ['당장', '급해', '급합니다', '긴급', '빨리', '두번결제', '이중결제', '중복결제', '정지', '밴', '접속이안', '로그인이안', '발송실패', '반송', '환불', '취소', '안들어왔', '미지급', '사라졌', '증발'];
const LOW_HINT = ['언제', '어디서', '어떻게', '방법', '궁금', '알려주', '사양', '가능한가요', '되나요', '있나요'];

export function heuristicSentiment(message: string): Sentiment {
  const text = compact(message) + (message.includes('!!') ? '!!' : '');
  const has = (list: string[]) => list.some((k) => text.includes(compact(k) || k));
  if (has(ANGRY) || /!{2,}/.test(message)) return 'angry';
  if (has(NEGATIVE)) return 'negative';
  if (has(POSITIVE)) return 'positive';
  return 'neutral';
}

export function heuristicUrgency(message: string, sentiment: Sentiment): Urgency {
  const text = compact(message);
  const has = (list: string[]) => list.some((k) => text.includes(compact(k)));
  if (has(CRITICAL)) return 'critical';
  if (has(HIGH) || sentiment === 'angry') return 'high';
  if (sentiment === 'negative') return 'medium';
  if (has(LOW_HINT)) return 'low';
  return 'medium';
}
