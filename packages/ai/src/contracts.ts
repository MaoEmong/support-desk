/**
 * AI 파이프라인 공유 계약 (zod).
 * @support/contracts 가 이 모듈을 re-export 한다. zod/v4 서브패스를 쓰므로 zod 3.25+ / 4.x 어디서든 같은 스키마로 동작한다.
 */
import { z } from 'zod/v4';

export const PIPELINE_VERSION = 'ai-pipeline@1';

// ---------------------------------------------------------------------------
// 분류
// ---------------------------------------------------------------------------

/** 카테고리 id 는 테넌트 설정이 정의한다(업종 하드코딩 금지). */
export const CategoryIdSchema = z
  .string()
  .min(1)
  .max(40)
  .regex(/^[a-z][a-z0-9_]*$/, '소문자·숫자·밑줄만 허용');
export type CategoryId = z.infer<typeof CategoryIdSchema>;

export const UrgencySchema = z.enum(['low', 'medium', 'high', 'critical']);
export type Urgency = z.infer<typeof UrgencySchema>;

export const SentimentSchema = z.enum(['positive', 'neutral', 'negative', 'angry']);
export type Sentiment = z.infer<typeof SentimentSchema>;

export const ClassificationResultSchema = z.object({
  category: CategoryIdSchema,
  urgency: UrgencySchema,
  sentiment: SentimentSchema,
  /** 분류기(LLM 또는 mock)의 자기보고 확신도. 최종 판단에는 confidence.final 을 쓴다. */
  confidence: z.number().min(0).max(1),
  /** 상담원용 한 줄 요약(보조 기능). */
  summary: z.string().max(300).optional(),
});
export type ClassificationResult = z.infer<typeof ClassificationResultSchema>;

// ---------------------------------------------------------------------------
// 근거 · 초안 · 실행 결과
// ---------------------------------------------------------------------------

export const SourceSchema = z.object({
  kbArticleId: z.string().min(1),
  title: z.string(),
  excerpt: z.string().max(400),
  tenantId: z.string().min(1),
  /** 0~1 로 정규화한 검색 점수 */
  score: z.number().min(0).max(1),
});
export type Source = z.infer<typeof SourceSchema>;

export const DecisionSchema = z.enum(['auto_answer', 'escalate', 'pending_approval']);
export type Decision = z.infer<typeof DecisionSchema>;

/** 결정 사유 전체 목록(화면 라벨 매핑·DB 검증용). 순서는 정책 문서 순서. */
export const DECISION_REASONS = [
  'confident_kb_match', // 자동답변 조건 충족
  'approval_mode', // 자동답변 조건은 충족했지만 테넌트가 승인 모드
  'forbidden_category', // 금지 카테고리(하드룰)
  'injection_suspected', // 프롬프트 인젝션 의심
  'suspicious_link', // 허용 도메인 밖 링크 포함
  'low_confidence', // 결합 확신도 < 임계값
  'no_sources', // 근거 문서 없음
  'auto_answer_limit', // 같은 티켓 자동답변 횟수 초과
  'unsafe_output', // 생성 결과가 출력 안전 검사에 걸림
  'provider_refusal', // 모델이 응답을 거부
  'ai_error', // 처리 오류 → 최종 이관
] as const;
export const DecisionReasonSchema = z.enum(DECISION_REASONS);
export type DecisionReason = z.infer<typeof DecisionReasonSchema>;

export const AIDraftStatusSchema = z.enum(['draft', 'approved', 'sent', 'rejected']);
export type AIDraftStatus = z.infer<typeof AIDraftStatusSchema>;

/** 파이프라인이 만든 답변 초안. 상태(draft→approved→sent)는 백엔드 ai_drafts 가 관리한다. */
export const AIDraftSchema = z.object({
  /** sanitize 를 거친 허용 마크다운 */
  body: z.string(),
  sources: z.array(SourceSchema),
  model: z.string(),
  /** 고객에게 바로 보낼 수 있는지(auto_answer 일 때만 true) */
  customerVisible: z.boolean(),
});
export type AIDraft = z.infer<typeof AIDraftSchema>;

export const AIUsageSchema = z.object({
  provider: z.enum(['mock', 'claude']),
  model: z.string(),
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
});
export type AIUsage = z.infer<typeof AIUsageSchema>;

export const AITimingSchema = z.object({
  classifyMs: z.number().nonnegative(),
  retrieveMs: z.number().nonnegative(),
  generateMs: z.number().nonnegative(),
  totalMs: z.number().nonnegative(),
});
export type AITiming = z.infer<typeof AITimingSchema>;

export const ConfidenceBreakdownSchema = z.object({
  /** 가중 결합 결과. 테넌트 threshold 와 비교한다. */
  final: z.number().min(0).max(1),
  llm: z.number().min(0).max(1),
  retrieval: z.number().min(0).max(1),
  rule: z.number().min(0).max(1),
});
export type ConfidenceBreakdown = z.infer<typeof ConfidenceBreakdownSchema>;

export const AIErrorCodeSchema = z.enum([
  'CONFIG_ERROR',
  'PROVIDER_ERROR',
  'PROVIDER_REFUSAL',
  'TENANT_MISMATCH',
  'NOT_FOUND',
  'INVALID_OUTPUT',
  'INTERNAL',
]);
export type AIErrorCode = z.infer<typeof AIErrorCodeSchema>;

export const AIRunErrorSchema = z.object({ code: AIErrorCodeSchema, message: z.string() });
export type AIRunError = z.infer<typeof AIRunErrorSchema>;

export const ProcessInquiryInputSchema = z
  .object({
    tenantId: z.string().min(1),
    ticketId: z.string().min(1).optional(),
    conversationId: z.string().min(1).optional(),
    messageId: z.string().min(1),
  })
  .refine((v) => (v.ticketId ? 1 : 0) + (v.conversationId ? 1 : 0) === 1, {
    message: 'ticketId 와 conversationId 중 정확히 하나가 필요합니다',
  });
export type ProcessInquiryInput = z.infer<typeof ProcessInquiryInputSchema>;

export const AIRunResultSchema = z.object({
  pipelineVersion: z.string(),
  tenantId: z.string(),
  ticketId: z.string().optional(),
  conversationId: z.string().optional(),
  messageId: z.string(),
  decision: DecisionSchema,
  reason: DecisionReasonSchema,
  /** 상담원·로그용 사람이 읽는 설명(고객 노출 금지) */
  reasonDetail: z.string(),
  classification: ClassificationResultSchema.nullable(),
  confidence: ConfidenceBreakdownSchema,
  sources: z.array(SourceSchema),
  draft: AIDraftSchema.nullable(),
  usage: z.array(AIUsageSchema),
  timing: AITimingSchema,
  flags: z.object({
    injectionSuspected: z.boolean(),
    suspiciousLinks: z.array(z.string()),
    removedOutputLinks: z.array(z.string()),
  }),
  error: AIRunErrorSchema.nullable(),
});
export type AIRunResult = z.infer<typeof AIRunResultSchema>;

// ---------------------------------------------------------------------------
// 챗봇 SSE 이벤트
// 순서: classified → (escalated → done) | (sources → token* → done)
//       어느 시점이든 error → done 가능. done 은 항상 마지막이며 정확히 1번.
// ---------------------------------------------------------------------------

export const SSEClassifiedEventSchema = z.object({
  type: z.literal('classified'),
  classification: ClassificationResultSchema,
});
export const SSESourcesEventSchema = z.object({
  type: z.literal('sources'),
  sources: z.array(SourceSchema),
});
export const SSETokenEventSchema = z.object({
  type: z.literal('token'),
  /** 안전 검사를 통과한 문장 단위 텍스트 조각(sanitize 완료) */
  text: z.string(),
});
export const SSEEscalatedEventSchema = z.object({
  type: z.literal('escalated'),
  decision: z.enum(['escalate', 'pending_approval']),
  reason: DecisionReasonSchema,
  /** 고객에게 보여줄 안내 문구 */
  notice: z.string(),
});
export const SSEDoneEventSchema = z.object({
  type: z.literal('done'),
  result: AIRunResultSchema,
});
export const SSEErrorEventSchema = z.object({
  type: z.literal('error'),
  code: AIErrorCodeSchema,
  message: z.string(),
});

export const SSEEventSchema = z.discriminatedUnion('type', [
  SSEClassifiedEventSchema,
  SSESourcesEventSchema,
  SSETokenEventSchema,
  SSEEscalatedEventSchema,
  SSEDoneEventSchema,
  SSEErrorEventSchema,
]);
export type SSEEvent = z.infer<typeof SSEEventSchema>;
export type SSEEventType = SSEEvent['type'];

/** SSE 와이어 포맷: `event: <type>\ndata: <json>\n\n` */
export function formatSSE(event: SSEEvent): string {
  return `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
}

// ---------------------------------------------------------------------------
// 테넌트 AI 설정
// ---------------------------------------------------------------------------

export const SYSTEM_PROMPT_MAX = 2000;

export const CategoryDefSchema = z.object({
  id: CategoryIdSchema,
  label: z.string().min(1).max(40),
  description: z.string().max(300).default(''),
  /** mock 분류기와 규칙 검사(하드룰)에 쓰는 키워드 */
  keywords: z.array(z.string().min(1).max(40)).max(80).default([]),
});
export type CategoryDef = z.infer<typeof CategoryDefSchema>;

const hostname = z
  .string()
  .min(1)
  .max(253)
  .regex(/^(?!-)[a-z0-9-]+(\.[a-z0-9-]+)+$/i, '호스트 이름만 허용(스킴·경로 없이)');

export const TenantAISettingsSchema = z
  .object({
    botName: z.string().min(1).max(40).default('고객지원 도우미'),
    /** 테넌트 톤·브랜드 지침. 안전 규칙은 플랫폼 프롬프트가 항상 우선한다. */
    systemPrompt: z.string().max(SYSTEM_PROMPT_MAX).default(''),
    /** 결합 확신도가 이 값 이상이어야 자동답변 */
    threshold: z.number().min(0).max(1).default(0.7),
    forbiddenCategories: z.array(CategoryIdSchema).default([]),
    approvalMode: z.boolean().default(false),
    categories: z.array(CategoryDefSchema).min(1).max(50),
    /** 분류 실패 시 쓰는 카테고리(자동답변 대상 아님) */
    fallbackCategory: CategoryIdSchema.default('other'),
    /** 답변·고객 메시지에서 허용하는 링크 도메인(하위 도메인 포함) */
    allowedLinkDomains: z.array(hostname).max(20).default([]),
    /** 같은 티켓에서 자동답변 최대 횟수 */
    autoAnswerLimit: z.number().int().min(0).max(5).default(1),
  })
  .superRefine((s, ctx) => {
    const ids = new Set(s.categories.map((c) => c.id));
    if (ids.size !== s.categories.length) {
      ctx.addIssue({ code: 'custom', path: ['categories'], message: '카테고리 id 중복' });
    }
    s.forbiddenCategories.forEach((id, i) => {
      if (!ids.has(id)) {
        ctx.addIssue({ code: 'custom', path: ['forbiddenCategories', i], message: `정의되지 않은 카테고리: ${id}` });
      }
    });
    if (!ids.has(s.fallbackCategory)) {
      ctx.addIssue({ code: 'custom', path: ['fallbackCategory'], message: `정의되지 않은 카테고리: ${s.fallbackCategory}` });
    }
  });
export type TenantAISettings = z.infer<typeof TenantAISettingsSchema>;
export type TenantAISettingsInput = z.input<typeof TenantAISettingsSchema>;

/** 관리자 화면 수정용: 부분 업데이트 입력(카테고리 정의는 별도 관리). */
export const TenantAISettingsPatchSchema = z
  .object({
    botName: z.string().min(1).max(40),
    systemPrompt: z.string().max(SYSTEM_PROMPT_MAX),
    threshold: z.number().min(0).max(1),
    forbiddenCategories: z.array(CategoryIdSchema),
    approvalMode: z.boolean(),
    allowedLinkDomains: z.array(hostname).max(20),
    autoAnswerLimit: z.number().int().min(0).max(5),
  })
  .partial()
  .strict();
export type TenantAISettingsPatch = z.infer<typeof TenantAISettingsPatchSchema>;

// ---------------------------------------------------------------------------
// 시드 데이터 형식 (packages/ai/data)
// ---------------------------------------------------------------------------

export const KbArticleSeedSchema = z.object({
  id: z.string().regex(/^[a-z]{2}-kb-\d{3}$/),
  category: CategoryIdSchema,
  title: z.string().min(1),
  question: z.string().min(1),
  answer: z.string().min(1),
  tags: z.array(z.string()).default([]),
  updatedAt: z.string(),
});
export type KbArticleSeed = z.infer<typeof KbArticleSeedSchema>;

export const KbSeedFileSchema = z.object({
  tenantSlug: z.string().min(1),
  version: z.number().int(),
  articles: z.array(KbArticleSeedSchema),
});
export type KbSeedFile = z.infer<typeof KbSeedFileSchema>;

export const TenantSettingsSeedFileSchema = z.object({
  tenantSlug: z.string().min(1),
  displayName: z.string().min(1),
  settings: TenantAISettingsSchema,
});
export type TenantSettingsSeedFile = z.infer<typeof TenantSettingsSeedFileSchema>;

export const EvalCaseSchema = z.object({
  id: z.string(),
  message: z.string().min(1),
  expectedCategory: CategoryIdSchema,
  expectedDecision: z.enum(['auto_answer', 'escalate']),
  expectedUrgency: UrgencySchema,
  expectedSentiment: SentimentSchema,
  expectedSourceIds: z.array(z.string()).default([]),
  tags: z.array(z.enum(['faq', 'forbidden', 'injection', 'malicious_link', 'ambiguous', 'angry', 'out_of_scope'])),
  mustNotContain: z.array(z.string()).default([]),
  notes: z.string().default(''),
});
export type EvalCase = z.infer<typeof EvalCaseSchema>;

export const EvalFileSchema = z.object({
  tenantSlug: z.string().min(1),
  version: z.number().int(),
  cases: z.array(EvalCaseSchema),
});
export type EvalFile = z.infer<typeof EvalFileSchema>;

// ---------------------------------------------------------------------------
// 시연 문장 (packages/ai/data/demo) — 시드·백엔드 테스트·E2E 가 공통으로 쓰는 유일한 원본
// ---------------------------------------------------------------------------

export const DemoChannelSchema = z.enum(['ticket', 'chat']);
export type DemoChannel = z.infer<typeof DemoChannelSchema>;

export const DemoCaseSchema = z
  .object({
    /** 테넌트 안에서 유일한 시나리오 키(E2E·시드가 이 키로 찾는다) */
    key: z.string().regex(/^[a-z][a-z0-9_]*$/),
    /** ticket: 문의 게시판(워커 processInquiry), chat: 챗봇(SSE streamInquiry) */
    channel: DemoChannelSchema,
    /** 티켓 제목(chat 은 '문의글로 남기기' 전환 시 제목) */
    title: z.string().min(1).max(120),
    /** 고객 메시지 원문 */
    message: z.string().min(1).max(2000),
    /** 이 시나리오가 전제하는 설정(시드 기본 설정과 다를 때만). 예: 승인 모드 시나리오는 approvalMode=true */
    settingsOverride: z
      .object({ approvalMode: z.boolean().optional(), threshold: z.number().min(0).max(1).optional() })
      .strict()
      .default({}),
    /** mock 모드, autoAnswerCount=0 기준 기대값 */
    expected: z.object({
      decision: DecisionSchema,
      reason: DecisionReasonSchema,
      category: CategoryIdSchema,
      /** confidence.final (소수 셋째 자리). 평가에서 ±0.0005 로 비교 */
      confidence: z.number().min(0).max(1),
    }),
    /** 임계값 경계 시나리오: 임계값을 이 값으로 바꾸면 결정이 이렇게 바뀐다 */
    thresholdProbe: z
      .object({ threshold: z.number().min(0).max(1), decision: DecisionSchema, reason: DecisionReasonSchema })
      .optional(),
    notes: z.string().default(''),
  })
  .superRefine((c, ctx) => {
    const p = c.thresholdProbe;
    if (p && p.decision === 'escalate' && !(p.threshold > c.expected.confidence)) {
      ctx.addIssue({ code: 'custom', path: ['thresholdProbe', 'threshold'], message: '이관 probe 임계값은 기대 confidence 보다 커야 합니다' });
    }
  });
export type DemoCase = z.infer<typeof DemoCaseSchema>;

export const DemoFileSchema = z
  .object({
    tenantSlug: z.string().min(1),
    version: z.number().int(),
    cases: z.array(DemoCaseSchema).min(1),
  })
  .superRefine((f, ctx) => {
    const seen = new Set<string>();
    f.cases.forEach((c, i) => {
      if (seen.has(c.key)) ctx.addIssue({ code: 'custom', path: ['cases', i, 'key'], message: `중복 key: ${c.key}` });
      seen.add(c.key);
    });
  });
export type DemoFile = z.infer<typeof DemoFileSchema>;
