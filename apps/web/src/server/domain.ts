/**
 * 서버 내부 도메인 타입. @support/db 확정 계약(API팀 요청 + 큐팀 필드 합집합)과 같은 이름을 쓴다.
 * 저장소 구현(Drizzle/메모리)과 서비스 계층 사이의 계약이며,
 * API 응답 DTO는 dto.ts에서 별도로 만든다(고객/상담원 분리).
 */
export type Role = 'customer' | 'agent' | 'tenant_admin' | 'platform_admin';

export type TicketStatus = 'open' | 'in_progress' | 'resolved' | 'closed';
/** 작성자 역할(사용자 role 또는 ai) */
export type MessageRole = 'customer' | 'agent' | 'tenant_admin' | 'ai';
export type AuthorType = 'customer' | 'agent' | 'ai' | 'system';
export type Visibility = 'public' | 'internal';
export type DraftStatus = 'draft' | 'approved' | 'sent' | 'rejected';
export type JobStatus = 'queued' | 'processing' | 'succeeded' | 'failed';
export type JobKind = 'process_inquiry' | 'regenerate_draft';
export type ConversationStatus = 'open' | 'converted' | 'closed';
/** 대화 system 안내 코드(공개 집합 3개) */
export type NoticeCode = 'APPROVAL_REQUIRED' | 'ESCALATED' | 'PROCESSING_FAILED';

export interface Source {
  kbArticleId: string;
  title: string;
  excerpt?: string;
  url?: string;
  tenantId?: string;
}

/** 고객 공개 메시지 근거(저장·응답 공통). 내부 Source(kbArticleId·tenantId·점수)는 ai_runs·ai_drafts에만 */
export interface PublicSource {
  id: string;
  title: string;
  excerpt?: string;
  /** https + 테넌트 allowedLinkDomains 통과 시에만(public-sources.ts) */
  url?: string;
}

export interface Tenant {
  id: string;
  slug: string;
  name: string;
  status: 'active' | 'suspended';
  createdAt: Date;
}

export interface TenantSettings {
  tenantId: string;
  displayName: string;
  logoUrl: string | null;
  primaryColor: string | null;
  chatbotName: string;
  aiSystemPrompt: string;
  aiThreshold: number;
  forbiddenCategories: string[];
  approvalMode: boolean;
  /** AI CategoryDefSchema 구조 그대로. id는 생성 후 바꾸지 않는다 */
  categories: CategoryDef[];
  /** categories 안의 id */
  fallbackCategory: string;
  /** 티켓당 자동답변 최대 수(1 고정, 관리자 수정 불가) */
  autoAnswerLimit: number;
  allowedLinkDomains: string[];
  /** KB 버전(단조 증가). KB 변경과 같은 tx에서 +1 → web·worker KB 캐시 무효화 키 */
  kbRevision: number;
  updatedAt: Date;
}

export interface CategoryDef {
  id: string;
  label: string;
  keywords: string[];
  description?: string;
}

export interface User {
  id: string;
  tenantId: string | null;
  email: string;
  passwordHash: string;
  name: string;
  role: Role;
  status: 'active' | 'disabled';
  createdAt: Date;
}

/** 쿠키 토큰 원문은 저장하지 않는다(id = sha256(token)). */
export interface Session {
  id: string;
  userId: string;
  tenantId: string | null;
  role: Role;
  csrfToken: string;
  createdAt: Date;
  lastSeenAt: Date;
  /** 절대 만료(createdAt + 최대 수명). 연장하지 않는다 */
  expiresAt: Date;
  revokedAt: Date | null;
  ip: string | null;
  userAgent: string | null;
}

export interface LoginAttempt {
  key: string;
  succeeded: boolean;
  ip: string | null;
  createdAt: Date;
}

export interface Ticket {
  id: string;
  tenantId: string;
  customerId: string;
  title: string;
  body: string;
  status: TicketStatus;
  version: number;
  category: string | null;
  urgency: string | null;
  sentiment: string | null;
  assigneeId: string | null;
  escalatedAt: Date | null;
  escalationReason: string | null;
  conversationId: string | null;
  idempotencyKey: string | null;
  autoReplyCount: number;
  autoAnsweredAt: Date | null;
  resolvedAt: Date | null;
  resolvedByCustomer: boolean;
  closedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface TicketMessage {
  id: string;
  tenantId: string;
  ticketId: string;
  authorId: string | null;
  role: MessageRole;
  authorType: AuthorType;
  visibility: Visibility;
  body: string;
  sources: PublicSource[] | null;
  draftId: string | null;
  sourceJobId: string | null;
  createdAt: Date;
}

export interface AiDraft {
  id: string;
  tenantId: string;
  /** 대화 출처 초안은 티켓 전환 전까지 null */
  ticketId: string | null;
  /** 출처: jobId(워커) XOR conversationId(SSE). 전환 후에도 conversationId는 유지 */
  conversationId: string | null;
  jobId: string | null;
  runId: string | null;
  body: string;
  sources: Source[] | null;
  status: DraftStatus;
  version: number;
  decidedBy: string | null;
  decidedAt: Date | null;
  rejectReason: string | null;
  sentMessageId: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface AiRun {
  id: string;
  tenantId: string;
  jobId: string | null;
  ticketId: string | null;
  conversationId: string | null;
  messageId: string | null;
  status: JobStatus;
  decision: string | null;
  reason: string | null;
  category: string | null;
  urgency: string | null;
  sentiment: string | null;
  confidence: number | null;
  sources: Source[] | null;
  model: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
  latencyMs: number | null;
  error: string | null;
  pipelineVersion: string | null;
  /** 큐 워커가 남기는 원본 결과(JSON) */
  result: Record<string, unknown> | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface Conversation {
  id: string;
  tenantId: string;
  customerId: string;
  status: ConversationStatus;
  ticketId: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface ConversationMessage {
  id: string;
  tenantId: string;
  conversationId: string;
  role: 'user' | 'assistant' | 'system';
  /** system 안내의 이관 사유(DecisionReason). 대화 복원 시 공개 escalationReason으로 매핑 */
  reason: string | null;
  /** system 안내 문구 선택 코드 */
  noticeCode: NoticeCode | null;
  body: string;
  sources: PublicSource[] | null;
  createdAt: Date;
}

export interface KbArticle {
  id: string;
  tenantId: string;
  title: string;
  /** 고객 질문 형태의 대표 질문(검색 가중) */
  question: string;
  body: string;
  category: string | null;
  tags: string[];
  published: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export interface AuditEntry {
  tenantId: string | null;
  actorId: string | null;
  action: string;
  targetType: string;
  targetId: string | null;
  meta?: Record<string, unknown> | null;
}

/** 인증된 요청 주체. 세션+사용자 행에서만 만든다(클라이언트 값 불신). */
export interface Actor {
  userId: string;
  role: Role;
  tenantId: string | null;
  name: string;
  email: string;
  sessionId: string;
  csrfToken: string;
}
