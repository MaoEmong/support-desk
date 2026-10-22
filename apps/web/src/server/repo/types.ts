import type {
  AiDraft,
  AiRun,
  AuditEntry,
  Conversation,
  ConversationMessage,
  DraftStatus,
  JobKind,
  ConversationStatus,
  KbArticle,
  LoginAttempt,
  Session,
  Tenant,
  TenantSettings,
  Ticket,
  TicketMessage,
  TicketStatus,
  User,
} from '../domain';

/**
 * 저장소 계약. 테넌트 리소스 메서드는 모두 tenantId를 첫 인자로 받아
 * 쿼리 단계에서 격리를 강제한다(서비스가 실수로 빠뜨릴 수 없도록).
 */
export interface TicketFilter {
  customerId?: string;
  status?: TicketStatus;
  category?: string;
  urgency?: string;
  sentiment?: string;
  /** 'none' = 미배정 */
  assigneeId?: string;
  escalated?: boolean;
}

export interface PageQuery {
  page: number;
  pageSize: number;
}

export interface Paged<T> {
  items: T[];
  page: number;
  pageSize: number;
  total: number;
}

export type NewTicket = Pick<Ticket, 'id' | 'tenantId' | 'customerId' | 'title' | 'body' | 'conversationId' | 'idempotencyKey'>;
export type TicketPatch = Partial<
  Pick<Ticket, 'status' | 'assigneeId' | 'escalatedAt' | 'escalationReason' | 'resolvedAt' | 'resolvedByCustomer' | 'closedAt'>
>;
export type DraftPatch = Partial<Pick<AiDraft, 'body' | 'status' | 'decidedBy' | 'decidedAt' | 'rejectReason' | 'sentMessageId'>>;
/** kbRevision은 KB 변경 시 저장소가 올린다(설정 PATCH로 바꾸지 않음) */
export type SettingsPatch = Partial<Omit<TenantSettings, 'tenantId' | 'updatedAt' | 'kbRevision'>>;
export type KbPatch = Partial<Pick<KbArticle, 'title' | 'question' | 'body' | 'category' | 'tags' | 'published'>>;

export interface EnqueueInput {
  tenantId: string;
  kind: JobKind;
  ticketId: string;
  messageId: string | null;
  idempotencyKey: string;
  pipelineVersion: string;
  maxAttempts: number;
}

export interface TenantMetrics {
  tenantId: string;
  ticketsTotal: number;
  ticketsByStatus: Record<TicketStatus, number>;
  escalatedTickets: number;
  autoAnsweredTickets: number;
  /** 자동답변 후 고객이 해결 확인했고 상담원 공개 답변이 없는 티켓 */
  autoResolvedTickets: number;
  categoryDistribution: Record<string, number>;
  aiRunsTotal: number;
  aiRunsFailed: number;
}

export interface Repo {
  /** fn 안의 모든 호출은 하나의 트랜잭션. 예외 시 전체 롤백. */
  tx<T>(fn: (repo: Repo) => Promise<T>): Promise<T>;

  // tenants
  getTenantBySlug(slug: string): Promise<Tenant | null>;
  listTenants(): Promise<Tenant[]>;
  getSettings(tenantId: string): Promise<TenantSettings | null>;
  updateSettings(tenantId: string, patch: SettingsPatch, now: Date): Promise<TenantSettings | null>;

  // users
  findUserByEmail(tenantId: string | null, email: string): Promise<User | null>;
  getUser(id: string): Promise<User | null>;
  getTenantUser(tenantId: string, id: string): Promise<User | null>;
  /** (tenantId, email) 중복이면 code '23505' 오류 */
  createUser(user: Omit<User, 'createdAt'>, now: Date): Promise<User>;
  listStaff(tenantId: string): Promise<User[]>;
  /** status가 expected일 때만 바꾼다(조건부). 아니면 null */
  updateUserStatusIf(tenantId: string, id: string, expected: User['status'], next: User['status'], now: Date): Promise<User | null>;
  /** 열린(open·in_progress) 티켓 담당 수. key = assigneeId */
  countOpenAssigned(tenantId: string): Promise<Record<string, number>>;

  // sessions
  createSession(session: Session): Promise<Session>;
  /** id = sha256(token) */
  getSession(id: string): Promise<Session | null>;
  touchSession(id: string, lastSeenAt: Date): Promise<void>;
  revokeSession(id: string, at: Date): Promise<void>;
  /** 사용자의 살아 있는 세션 전부 폐기. 폐기한 수 */
  revokeUserSessions(userId: string, at: Date): Promise<number>;

  // login attempts
  recordLoginAttempt(attempt: LoginAttempt): Promise<void>;
  countFailedAttempts(key: string, since: Date): Promise<number>;

  // tickets (모든 갱신은 version+1)
  createTicket(ticket: NewTicket, now: Date): Promise<Ticket>;
  getTicket(tenantId: string, id: string): Promise<Ticket | null>;
  findTicketByIdempotencyKey(tenantId: string, customerId: string, key: string): Promise<Ticket | null>;
  /** 트랜잭션 안에서 행 잠금(SELECT … FOR UPDATE). 공개 답변·초안 승인·자동답변이 같은 잠금을 쓴다. */
  lockTicket(tenantId: string, id: string): Promise<Ticket | null>;
  findTicketByConversation(tenantId: string, conversationId: string): Promise<Ticket | null>;
  listTickets(tenantId: string, filter: TicketFilter, page: PageQuery): Promise<Paged<Ticket>>;
  updateTicket(tenantId: string, id: string, patch: TicketPatch, now: Date): Promise<Ticket | null>;
  /** version이 일치할 때만 갱신. 아니면 null */
  updateTicketIfVersion(tenantId: string, id: string, expectedVersion: number, patch: TicketPatch, now: Date): Promise<Ticket | null>;

  // ticket messages
  addTicketMessage(msg: Omit<TicketMessage, 'createdAt'>, now: Date): Promise<TicketMessage>;
  listTicketMessages(tenantId: string, ticketId: string): Promise<TicketMessage[]>;

  // drafts & runs
  createDraft(draft: Omit<AiDraft, 'createdAt' | 'updatedAt'>, now: Date): Promise<AiDraft>;
  getDraft(tenantId: string, id: string): Promise<AiDraft | null>;
  listDrafts(tenantId: string, ticketId: string): Promise<AiDraft[]>;
  /** 조건부 갱신(낙관적 잠금). version 일치 + status ∈ allowed 일 때만 갱신하고 version+1. 아니면 null */
  updateDraftIfVersion(
    tenantId: string,
    id: string,
    expectedVersion: number,
    allowedStatuses: DraftStatus[],
    patch: DraftPatch,
    now: Date,
  ): Promise<AiDraft | null>;
  /** 티켓의 워커 실행 + (대화에서 전환됐으면) 그 대화의 SSE 실행 */
  listRuns(tenantId: string, ticketId: string, conversationId?: string | null): Promise<AiRun[]>;
  /** 작업 없는(SSE) 실행 기록. (tenant, conversation, message, pipeline) 부분 unique */
  createRun(run: Omit<AiRun, 'createdAt' | 'updatedAt'>, now: Date): Promise<AiRun>;
  /**
   * 대화당 초안 1개(conversationId UNIQUE). 없으면 만들고, 전환 전(ticketId null)·미발송(draft/approved)이면
   * 최신 결과로 본문·근거·runId를 바꾸고 version+1(status draft). 이미 전환·발송·반려된 초안은 그대로 둔다.
   */
  saveConversationDraft(
    d: { id: string; tenantId: string; conversationId: string; runId: string; body: string; sources: AiDraft['sources'] },
    now: Date,
  ): Promise<AiDraft>;
  /** 대화 출처 초안을 전환 티켓에 연결(같은 행에 ticketId만 추가, conversationId 출처 유지). 연결 수 */
  attachConversationDrafts(tenantId: string, conversationId: string, ticketId: string, now: Date): Promise<number>;

  // jobs
  /** (tenantId, idempotencyKey) 중복이면 새로 만들지 않고 기존 작업 id를 돌려준다. */
  enqueueJob(input: EnqueueInput, now: Date): Promise<{ jobId: string }>;
  findActiveJob(tenantId: string, ticketId: string, kind: JobKind): Promise<{ id: string } | null>;

  // conversations
  createConversation(c: Omit<Conversation, 'createdAt' | 'updatedAt'>, now: Date): Promise<Conversation>;
  getConversation(tenantId: string, id: string): Promise<Conversation | null>;
  /** status가 expectedStatus일 때만 갱신(조건부). 아니면 null */
  updateConversationIfStatus(
    tenantId: string,
    id: string,
    expectedStatus: ConversationStatus,
    patch: Partial<Pick<Conversation, 'status' | 'ticketId'>>,
    now: Date,
  ): Promise<Conversation | null>;
  addConversationMessage(m: Omit<ConversationMessage, 'createdAt'>, now: Date): Promise<ConversationMessage>;
  listConversationMessages(tenantId: string, conversationId: string): Promise<ConversationMessage[]>;

  // kb
  listKb(tenantId: string): Promise<KbArticle[]>;
  getKb(tenantId: string, id: string): Promise<KbArticle | null>;
  /** 생성·수정·삭제는 같은 실행기(tx)에서 tenant_settings.kbRevision +1 */
  createKb(a: Omit<KbArticle, 'createdAt' | 'updatedAt'>, now: Date): Promise<KbArticle>;
  updateKb(tenantId: string, id: string, patch: KbPatch, now: Date): Promise<KbArticle | null>;
  deleteKb(tenantId: string, id: string): Promise<boolean>;

  // audit & metrics
  audit(entry: AuditEntry, now: Date): Promise<void>;
  tenantMetrics(tenantId: string): Promise<TenantMetrics>;
}

export const isUniqueViolation = (e: unknown): boolean => {
  if (typeof e !== 'object' || e === null) return false;
  const o = e as { code?: string; cause?: unknown };
  return o.code === '23505' || isUniqueViolation(o.cause);
};
