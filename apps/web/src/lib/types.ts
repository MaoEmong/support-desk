/**
 * 화면용 응답 타입. 서버 dto.ts의 JSON 직렬화 결과(날짜 = ISO 문자열)를 그대로 옮긴 것이다.
 * 계약 기본 타입(Role, TicketStatus 등)은 @support/contracts를 재사용한다.
 */
import type { AIDraftStatus, AIRunStatus, Role, TicketStatus } from '@support/contracts';

export type { Role, TicketStatus, AIDraftStatus, AIRunStatus };
import type { DecisionReason, NoticeCodeSchema } from '@support/contracts';
import type { z } from 'zod';

export type CustomerStatus = 'received' | 'answered' | 'in_progress' | 'resolved' | 'closed';
export type AuthorType = 'customer' | 'agent' | 'ai' | 'system';
export type MessageRole = 'customer' | 'agent' | 'tenant_admin' | 'ai';
export type Visibility = 'public' | 'internal';

export interface Page<T> {
  items: T[];
  page: number;
  pageSize: number;
  total: number;
}

export interface PublicSettings {
  slug: string;
  name: string;
  displayName: string;
  logoUrl: string | null;
  primaryColor: string | null;
  chatbotName: string;
  approvalMode: boolean;
  aiMode: 'mock' | 'claude';
  /**
   * 고객 화면 링크 허용 도메인(회의 결정 7-①). 백엔드 반영 전에는 없을 수 있어 optional.
   * 링크 차단의 1차 방어는 서버 sanitize이고, 화면(SafeMarkdown·SourceList)은 2차 방어다.
   */
  allowedLinkDomains?: string[];
  /** 분류 라벨 목록(부장 확정 키). 대시보드 큐 라벨용. 백엔드 반영 전에는 없을 수 있다. */
  categories?: { id: string; label: string }[];
}

export interface Me {
  user: { id: string; tenantId: string | null; email: string; name: string; role: Role };
  tenant: { slug: string } | null;
  csrfToken: string;
}

/** 고객용 근거 */
export interface PublicSource {
  id: string;
  title: string;
  url?: string;
  excerpt?: string | null;
}

/** 초안·AI 분석용 근거(서버 내부 형태). StaffMessage는 PublicSource를 사용한다. */
export interface StaffSource {
  kbArticleId: string;
  title: string;
  excerpt?: string;
  url?: string;
}

export interface CustomerTicket {
  id: string;
  title: string;
  body: string;
  status: TicketStatus;
  version: number;
  customerStatus: CustomerStatus;
  createdAt: string;
  updatedAt: string;
  resolvedAt: string | null;
  closedAt: string | null;
}

export interface CustomerMessage {
  id: string;
  role: MessageRole;
  authorType: AuthorType;
  authorName: string;
  body: string;
  sources: PublicSource[];
  createdAt: string;
}

export interface CustomerTicketDetail extends CustomerTicket {
  canConfirmResolved: boolean;
  canComment: boolean;
  messages: CustomerMessage[];
}

export interface UserRef {
  id: string;
  name: string;
  email: string | null;
}

export interface StaffTicket {
  id: string;
  tenantId: string;
  title: string;
  body: string;
  status: TicketStatus;
  version: number;
  customerId: string;
  assigneeId: string | null;
  customer: UserRef | null;
  assignee: UserRef | null;
  category: string | null;
  urgency: string | null;
  sentiment: string | null;
  escalated: boolean;
  escalatedAt: string | null;
  escalationReason: string | null;
  autoReplyCount: number;
  autoAnsweredAt: string | null;
  conversationId: string | null;
  resolvedAt: string | null;
  resolvedByCustomer: boolean;
  closedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface StaffMessage {
  id: string;
  tenantId: string;
  ticketId: string;
  authorId: string | null;
  role: MessageRole;
  authorType: AuthorType;
  authorName: string;
  visibility: Visibility;
  body: string;
  sources: PublicSource[];
  draftId: string | null;
  sourceJobId: string | null;
  createdAt: string;
}

export interface Draft {
  id: string;
  ticketId: string;
  jobId: string | null;
  runId: string | null;
  body: string;
  sources: StaffSource[];
  status: AIDraftStatus;
  version: number;
  decidedBy: string | null;
  decidedAt: string | null;
  rejectReason: string | null;
  sentMessageId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface AiRun {
  id: string;
  jobId: string | null;
  status: AIRunStatus;
  result: Record<string, unknown> | null;
  decision: string | null;
  reason: string | null;
  category: string | null;
  urgency: string | null;
  sentiment: string | null;
  confidence: number | null;
  sources: StaffSource[];
  model: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
  latencyMs: number | null;
  error: string | null;
  pipelineVersion: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface StaffTicketDetail extends StaffTicket {
  messages: StaffMessage[];
  drafts: Draft[];
  aiRuns: AiRun[];
}

export interface Agent {
  id: string;
  name: string;
  email: string;
  role: Role;
  status?: 'active' | 'disabled';
  assignedOpenCount?: number;
}

export interface TenantMetrics {
  tenantId: string;
  ticketsTotal: number;
  ticketsByStatus: Record<TicketStatus, number>;
  escalatedTickets: number;
  autoAnsweredTickets: number;
  autoResolvedTickets: number;
  categoryDistribution: Record<string, number>;
  aiRunsTotal: number;
  aiRunsFailed: number;
  autoResolutionRate: number;
  escalationRate: number;
  aiMode: 'mock' | 'claude';
}

export interface CategoryDefinition {
  id: string;
  label: string;
  keywords: string[];
  description?: string;
}

export interface CategoryLabel {
  id: string;
  label: string;
}

export interface AdminSettings {
  displayName: string;
  logoUrl: string | null;
  primaryColor: string | null;
  chatbotName: string;
  aiSystemPrompt: string;
  aiThreshold: number;
  forbiddenCategories: string[];
  approvalMode: boolean;
  categories: (CategoryDefinition | string)[];
  fallbackCategory?: string;
  autoAnswerLimit?: 1;
  allowedLinkDomains: string[];
  updatedAt: string;
}

export interface KbArticle {
  id: string;
  title: string;
  body: string;
  category: string | null;
  tags: string[];
  published: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface Conversation {
  id: string;
  status: 'open' | 'converted' | 'closed';
  ticketId: string | null;
  createdAt: string;
  updatedAt: string;
  messages: ConversationMessage[];
}

export interface ConversationMessage {
  id: string;
  role: 'user' | 'assistant' | 'system';
  body: string;
  sources: PublicSource[];
  createdAt: string;
  /** system(이관 안내) 메시지의 공개 이관 사유(contracts ConversationMessageSchema, system에만 온다) */
  escalationReason?: DecisionReason;
  /** system 메시지의 공개 안내 코드. 안내 문구 선택의 1순위(system에만 온다) */
  noticeCode?: NoticeCode;
}

/** 대화 복원 system 메시지 안내 코드(@support/contracts NoticeCodeSchema) */
export type NoticeCode = z.infer<typeof NoticeCodeSchema>;

export interface PlatformTenant {
  id: string;
  slug: string;
  name: string;
  status: 'active' | 'suspended';
  createdAt: string;
  metrics: Omit<TenantMetrics, 'tenantId' | 'aiMode'>;
}

export interface PlatformMetrics {
  tenantsTotal: number;
  tenantsActive: number;
  ticketsTotal: number;
  escalatedTickets: number;
  autoResolvedTickets: number;
  autoAnsweredTickets: number;
  aiRunsTotal: number;
  aiRunsFailed: number;
  autoResolutionRate: number;
  escalationRate: number;
}
