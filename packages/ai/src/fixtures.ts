/**
 * 프론트 MSW 목업용 샘플 데이터. 모든 값은 contracts 스키마를 통과한다(테스트로 검증).
 * 테넌트 A(pixelforge) 시나리오: 자동답변 1건 / 금지 카테고리 이관 1건 / 승인 대기 1건, 챗봇 SSE 이벤트 시퀀스 2종.
 */
import type { AIRunResult, ClassificationResult, SSEEvent, Source, TenantAISettingsInput } from './contracts';
import { PIPELINE_VERSION } from './contracts';

const TENANT = 'tenant-pixelforge';

export const sampleSources: Source[] = [
  {
    kbArticleId: 'pf-kb-001',
    title: 'PC 최소·권장 사양',
    excerpt: '최소 사양은 64비트 운영체제, 4코어 프로세서, 메모리 8GB, 그래픽 메모리 2GB입니다. 권장 사양은 6코어 프로세서, 메모리 16GB…',
    tenantId: TENANT,
    score: 0.92,
  },
];

export const sampleClassificationFaq: ClassificationResult = {
  category: 'install',
  urgency: 'low',
  sentiment: 'neutral',
  confidence: 0.85,
  summary: '[설치·사양·업데이트] PC 권장 사양 문의',
};

export const sampleClassificationRefund: ClassificationResult = {
  category: 'refund',
  urgency: 'high',
  sentiment: 'angry',
  confidence: 0.9,
  summary: '[환불] 중복 결제 취소 요청',
};

const timing = { classifyMs: 412, retrieveMs: 8, generateMs: 1830, totalMs: 2250 };
const usage = [
  { provider: 'claude' as const, model: 'claude-opus-5-5', inputTokens: 612, outputTokens: 64 },
  { provider: 'claude' as const, model: 'claude-opus-5-5', inputTokens: 1480, outputTokens: 210 },
];
const noFlags = { injectionSuspected: false, suspiciousLinks: [], removedOutputLinks: [] };

export const sampleRunAutoAnswer: AIRunResult = {
  pipelineVersion: PIPELINE_VERSION,
  tenantId: TENANT,
  ticketId: 'ticket-0001',
  messageId: 'msg-0001',
  decision: 'auto_answer',
  reason: 'confident_kb_match',
  reasonDetail: '결합 확신도 0.88 ≥ 임계값 0.70',
  classification: sampleClassificationFaq,
  confidence: { final: 0.88, llm: 0.85, retrieval: 0.92, rule: 1 },
  sources: sampleSources,
  draft: {
    body: '안녕하세요, 모험가님! 픽셀포지 도우미입니다.\n\n- **최소 사양**: 4코어 CPU, 메모리 8GB, 그래픽 메모리 2GB\n- **권장 사양**: 6코어 CPU, 메모리 16GB, 그래픽 메모리 6GB\n\n저장 공간은 40GB 이상 확보해 주세요. 자세한 내용은 [도움말](https://help.pixelforge.example/articles/pf-001)에서 확인하실 수 있어요.',
    sources: sampleSources,
    model: 'claude-opus-5-5',
    customerVisible: true,
  },
  usage,
  timing,
  flags: noFlags,
  error: null,
};

export const sampleRunEscalated: AIRunResult = {
  pipelineVersion: PIPELINE_VERSION,
  tenantId: TENANT,
  ticketId: 'ticket-0002',
  messageId: 'msg-0002',
  decision: 'escalate',
  reason: 'forbidden_category',
  reasonDetail: '금지 카테고리(refund)로 분류되어 상담원 처리',
  classification: sampleClassificationRefund,
  confidence: { final: 0.71, llm: 0.9, retrieval: 0.55, rule: 1 },
  sources: [
    {
      kbArticleId: 'pf-kb-020',
      title: '중복 결제 취소 확인 절차',
      excerpt: '중복 결제가 의심되면 결제 내역 화면에서 주문 번호를 확인한 뒤 문의해 주세요…',
      tenantId: TENANT,
      score: 0.55,
    },
  ],
  draft: {
    body: '안녕하세요, 모험가님. 결제가 두 번 진행된 것 같아 많이 놀라셨을 것 같아요.\n\n담당 상담원이 결제 내역을 직접 확인한 뒤 이 문의글로 안내드리겠습니다. 확인을 위해 **주문 번호**와 **결제 일시**를 남겨 주시면 더 빠르게 도와드릴 수 있어요.',
    sources: [],
    model: 'claude-opus-5-5',
    customerVisible: false,
  },
  usage,
  timing,
  flags: noFlags,
  error: null,
};

export const sampleRunPendingApproval: AIRunResult = {
  ...sampleRunAutoAnswer,
  ticketId: 'ticket-0003',
  messageId: 'msg-0003',
  decision: 'pending_approval',
  reason: 'approval_mode',
  reasonDetail: '승인 모드: 상담원 승인 후 고객에게 노출',
  draft: { ...sampleRunAutoAnswer.draft!, customerVisible: false },
};

export const sampleRunAiError: AIRunResult = {
  pipelineVersion: PIPELINE_VERSION,
  tenantId: TENANT,
  ticketId: 'ticket-0004',
  messageId: 'msg-0004',
  decision: 'escalate',
  reason: 'ai_error',
  reasonDetail: 'AI 처리 실패(PROVIDER_ERROR) — 상담원 처리',
  classification: null,
  confidence: { final: 0, llm: 0, retrieval: 0, rule: 0 },
  sources: [],
  draft: null,
  usage: [],
  timing: { classifyMs: 0, retrieveMs: 0, generateMs: 0, totalMs: 60012 },
  flags: noFlags,
  error: { code: 'PROVIDER_ERROR', message: 'Claude API 오류(529): overloaded' },
};

/** 챗봇: 자동답변 스트림 */
export const sampleSSEAutoAnswer: SSEEvent[] = [
  { type: 'classified', classification: sampleClassificationFaq },
  { type: 'sources', sources: sampleSources },
  { type: 'token', text: '안녕하세요, 모험가님! 픽셀포지 도우미입니다.\n\n' },
  { type: 'token', text: '- **최소 사양**: 4코어 CPU, 메모리 8GB, 그래픽 메모리 2GB\n' },
  { type: 'token', text: '- **권장 사양**: 6코어 CPU, 메모리 16GB, 그래픽 메모리 6GB\n\n' },
  { type: 'token', text: '저장 공간은 40GB 이상 확보해 주세요. 자세한 내용은 [도움말](https://help.pixelforge.example/articles/pf-001)에서 확인하실 수 있어요.' },
  { type: 'done', result: { ...sampleRunAutoAnswer, ticketId: undefined, conversationId: 'conv-0001' } },
];

/** 챗봇: 금지 카테고리 → token 없이 이관 */
export const sampleSSEEscalated: SSEEvent[] = [
  { type: 'classified', classification: sampleClassificationRefund },
  { type: 'escalated', decision: 'escalate', reason: 'forbidden_category', notice: '문의 내용을 담당 상담원에게 전달했어요. 확인 후 답변드릴게요.' },
  { type: 'done', result: { ...sampleRunEscalated, ticketId: undefined, conversationId: 'conv-0002' } },
];

/** 관리자 설정 화면 기본값 예시(입력 형태) */
export const sampleTenantAISettings: TenantAISettingsInput = {
  botName: '픽셀포지 도우미',
  systemPrompt: '모험가님이라고 부르고, 밝고 친근하지만 예의 바른 말투를 씁니다.',
  threshold: 0.7,
  forbiddenCategories: ['refund', 'hacking', 'sanction'],
  approvalMode: false,
  fallbackCategory: 'other',
  allowedLinkDomains: ['help.pixelforge.example'],
  autoAnswerLimit: 1,
  categories: [
    { id: 'install', label: '설치·사양·업데이트', description: '', keywords: ['설치', '사양'] },
    { id: 'refund', label: '환불', description: '', keywords: ['환불'] },
    { id: 'hacking', label: '해킹·계정도용', description: '', keywords: ['해킹'] },
    { id: 'sanction', label: '제재·신고', description: '', keywords: ['정지'] },
    { id: 'other', label: '기타', description: '', keywords: [] },
  ],
};
