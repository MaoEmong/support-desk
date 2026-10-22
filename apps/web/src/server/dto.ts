import { DecisionReasonSchema, type DecisionReason } from '@support/ai';
import type {
  AiDraft,
  AiRun,
  Conversation,
  ConversationMessage,
  KbArticle,
  Tenant,
  TenantSettings,
  Ticket,
  TicketMessage,
  User,
} from './domain';
import { toPublicSources, type SourcePolicy } from './public-sources';

/**
 * 응답 DTO. @support/contracts의 CustomerTicket·StaffTicket 계열 스키마 필드를 기본으로 하고 화면용 필드를 덧붙인다.
 * 고객용과 상담원용을 "다른 함수"로 만들어(화이트리스트) 고객 경로에
 * tenantId·내부 메모·초안·AI 분석이 실수로라도 섞이지 않게 한다.
 */

export type CustomerStatus = 'received' | 'answered' | 'in_progress' | 'resolved' | 'closed';

/** 고객 표시 상태: open이라도 마지막 공개 메시지가 상담원/AI면 '답변 완료'로 보여준다. */
export function customerStatus(t: Pick<Ticket, 'status'>, publicMessages: Pick<TicketMessage, 'authorType'>[]): CustomerStatus {
  if (t.status !== 'open') return t.status === 'in_progress' ? 'in_progress' : t.status;
  const last = publicMessages.at(-1);
  return last && (last.authorType === 'agent' || last.authorType === 'ai') ? 'answered' : 'received';
}

export interface NameBook {
  users: Map<string, Pick<User, 'id' | 'name' | 'email' | 'role'>>;
  chatbotName: string;
  /** 메시지 근거 공개 정책(테넌트·허용 링크 도메인) */
  sources: SourcePolicy;
}

// ---------- 고객 ----------
export function toCustomerTicket(t: Ticket, publicMessages: TicketMessage[]) {
  return {
    id: t.id,
    title: t.title,
    body: t.body,
    status: t.status,
    version: t.version,
    customerStatus: customerStatus(t, publicMessages),
    createdAt: t.createdAt,
    updatedAt: t.updatedAt,
    resolvedAt: t.resolvedAt,
    closedAt: t.closedAt,
  };
}

function authorName(m: TicketMessage, names: NameBook) {
  if (m.authorType === 'ai') return names.chatbotName;
  if (m.authorType === 'system') return '안내';
  const u = names.users.get(m.authorId ?? '');
  return u?.name ?? (m.authorType === 'agent' ? '상담원' : '고객');
}

export function toCustomerMessage(m: TicketMessage, names: NameBook) {
  return {
    id: m.id,
    role: m.role,
    authorType: m.authorType,
    authorName: authorName(m, names),
    body: m.body,
    sources: toPublicSources(m.sources, names.sources),
    createdAt: m.createdAt,
  };
}

/** 호출자가 public만 넘기지만, 여기서도 한 번 더 거른다(이중 방어). */
export function toCustomerTicketDetail(t: Ticket, messages: TicketMessage[], names: NameBook) {
  const pub = messages.filter((m) => m.visibility === 'public');
  return {
    ...toCustomerTicket(t, pub),
    canConfirmResolved: t.status === 'open' || t.status === 'in_progress',
    canComment: t.status !== 'closed',
    messages: pub.map((m) => toCustomerMessage(m, names)),
  };
}

// ---------- 상담원 / 테넌트 관리자 ----------
const userRef = (names: NameBook, id: string | null) => {
  if (!id) return null;
  const u = names.users.get(id);
  return u ? { id: u.id, name: u.name, email: u.email } : { id, name: '(알 수 없음)', email: null };
};

export function toStaffTicket(t: Ticket, names: NameBook) {
  return {
    id: t.id,
    tenantId: t.tenantId,
    title: t.title,
    body: t.body,
    status: t.status,
    version: t.version,
    customerId: t.customerId,
    assigneeId: t.assigneeId,
    customer: userRef(names, t.customerId),
    assignee: userRef(names, t.assigneeId),
    category: t.category,
    urgency: t.urgency,
    sentiment: t.sentiment,
    escalated: t.escalatedAt !== null,
    escalatedAt: t.escalatedAt,
    escalationReason: t.escalationReason,
    autoReplyCount: t.autoReplyCount,
    autoAnsweredAt: t.autoAnsweredAt,
    conversationId: t.conversationId,
    resolvedAt: t.resolvedAt,
    resolvedByCustomer: t.resolvedByCustomer,
    closedAt: t.closedAt,
    createdAt: t.createdAt,
    updatedAt: t.updatedAt,
  };
}

export function toStaffMessage(m: TicketMessage, names: NameBook) {
  return {
    id: m.id,
    tenantId: m.tenantId,
    ticketId: m.ticketId,
    authorId: m.authorId,
    role: m.role,
    authorType: m.authorType,
    authorName: authorName(m, names),
    visibility: m.visibility,
    body: m.body,
    sources: toPublicSources(m.sources, names.sources),
    draftId: m.draftId,
    sourceJobId: m.sourceJobId,
    createdAt: m.createdAt,
  };
}

export function toDraft(d: AiDraft) {
  return {
    id: d.id,
    ticketId: d.ticketId,
    // 출처: jobId(워커) 또는 conversationId(챗봇 SSE)
    conversationId: d.conversationId,
    jobId: d.jobId,
    runId: d.runId,
    body: d.body,
    sources: d.sources ?? [],
    status: d.status,
    version: d.version,
    decidedBy: d.decidedBy,
    decidedAt: d.decidedAt,
    rejectReason: d.rejectReason,
    sentMessageId: d.sentMessageId,
    createdAt: d.createdAt,
    updatedAt: d.updatedAt,
  };
}

/**
 * DB reason(text) → 공개 DecisionReason. 큐 내부 실패 코드(lease_expired 등)는 enum이 아니므로
 * 실패 실행은 ai_error, 그 밖의 값은 null로 명시 매핑한다(임의 문자열을 화면 계약에 흘리지 않음).
 */
export function toDecisionReason(reason: string | null, failed = false): DecisionReason | null {
  const parsed = DecisionReasonSchema.safeParse(reason);
  return parsed.success ? parsed.data : failed ? 'ai_error' : null;
}

/**
 * ai_runs.result 읽기 정규화: 원본 AI 결과는 항상 result.aiResult(워커 envelope·SSE 공통).
 * 원본을 최상위에 저장했던 과거 SSE 행만 읽을 때 {aiResult: 원본}으로 감싼다(저장 데이터는 바꾸지 않음).
 */
export function normalizeRunResult(result: Record<string, unknown> | null): Record<string, unknown> | null {
  if (!result || 'aiResult' in result) return result;
  // 원본 AIRunResult의 confidence는 객체(평탄 큐 형식은 숫자 또는 null — typeof null === 'object'이므로 명시 제외)
  const legacyRaw =
    typeof result.pipelineVersion === 'string' && typeof result.decision === 'string' && typeof result.confidence === 'object' && result.confidence !== null;
  return legacyRaw ? { aiResult: result } : result;
}

export function toAiRun(r: AiRun) {
  return {
    id: r.id,
    jobId: r.jobId,
    conversationId: r.conversationId,
    status: r.status,
    result: normalizeRunResult(r.result),
    decision: r.decision,
    reason: toDecisionReason(r.reason, r.status === 'failed'),
    category: r.category,
    urgency: r.urgency,
    sentiment: r.sentiment,
    confidence: r.confidence,
    sources: r.sources ?? [],
    model: r.model,
    inputTokens: r.inputTokens,
    outputTokens: r.outputTokens,
    latencyMs: r.latencyMs,
    error: r.error,
    pipelineVersion: r.pipelineVersion,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  };
}

export function toStaffTicketDetail(t: Ticket, messages: TicketMessage[], drafts: AiDraft[], runs: AiRun[], names: NameBook) {
  return {
    ...toStaffTicket(t, names),
    messages: messages.map((m) => toStaffMessage(m, names)),
    drafts: drafts.map(toDraft),
    aiRuns: runs.map(toAiRun),
  };
}

// ---------- 공통 ----------
export function toPublicSettings(tenant: Pick<Tenant, 'slug' | 'name'>, s: TenantSettings, aiMode: 'mock' | 'claude') {
  return {
    slug: tenant.slug,
    name: tenant.name,
    displayName: s.displayName || tenant.name,
    logoUrl: s.logoUrl,
    primaryColor: s.primaryColor,
    chatbotName: s.chatbotName,
    approvalMode: s.approvalMode,
    allowedLinkDomains: s.allowedLinkDomains,
    // 공개는 라벨만(키워드·설명은 분류 규칙이라 관리자 화면에서만)
    categories: s.categories.map(({ id, label }) => ({ id, label })),
    aiMode,
  };
}

export function toAdminSettings(s: TenantSettings) {
  return {
    displayName: s.displayName,
    logoUrl: s.logoUrl,
    primaryColor: s.primaryColor,
    chatbotName: s.chatbotName,
    aiSystemPrompt: s.aiSystemPrompt,
    aiThreshold: s.aiThreshold,
    forbiddenCategories: s.forbiddenCategories,
    approvalMode: s.approvalMode,
    categories: s.categories,
    fallbackCategory: s.fallbackCategory,
    autoAnswerLimit: s.autoAnswerLimit,
    allowedLinkDomains: s.allowedLinkDomains,
    updatedAt: s.updatedAt,
  };
}

export const toKb = (a: KbArticle) => ({
  id: a.id,
  title: a.title,
  question: a.question,
  body: a.body,
  category: a.category,
  tags: a.tags,
  published: a.published,
  createdAt: a.createdAt,
  updatedAt: a.updatedAt,
});

export const toConversation = (c: Conversation, messages: ConversationMessage[], policy: SourcePolicy) => ({
  id: c.id,
  status: c.status,
  ticketId: c.ticketId,
  createdAt: c.createdAt,
  updatedAt: c.updatedAt,
  messages: messages.map((m) => toConversationMessage(m, policy)),
});

/**
 * 대화 복원 메시지. system 안내에만 escalationReason(DB reason → DecisionReason 명시 매핑, enum 밖이면 생략)과
 * noticeCode(승인 3종일 때만)를 싣는다. 다른 role에는 두 키 모두 없다(null 키 아님).
 */
export function toConversationMessage(m: ConversationMessage, policy: SourcePolicy) {
  const base = { id: m.id, role: m.role, body: m.body, sources: toPublicSources(m.sources, policy), createdAt: m.createdAt };
  if (m.role !== 'system') return base;
  const reason = toDecisionReason(m.reason);
  return { ...base, ...(reason ? { escalationReason: reason } : {}), ...(m.noticeCode ? { noticeCode: m.noticeCode } : {}) };
}

/** 계약 SessionUserSchema + csrfToken */
export const toMe = (u: Pick<User, 'id' | 'name' | 'email' | 'role' | 'tenantId'>, csrfToken: string, tenant: Pick<Tenant, 'slug'> | null) => ({
  user: { id: u.id, tenantId: u.tenantId, email: u.email, name: u.name, role: u.role },
  tenant: tenant ? { slug: tenant.slug } : null,
  csrfToken,
});
