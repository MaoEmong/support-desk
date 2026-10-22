import { randomUUID } from 'node:crypto';
import { and, count, desc, eq, gte, inArray, isNotNull, isNull, or, sql, type SQL } from 'drizzle-orm';
import type { PgUpdateSetSource } from 'drizzle-orm/pg-core';
import { schema, type Database } from '@support/db';
import { enqueueInquiry } from '@support/queue';
import type {
  AiDraft,
  AiRun,
  AuditEntry,
  Conversation,
  ConversationMessage,
  ConversationStatus,
  DraftStatus,
  JobKind,
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
import type {
  DraftPatch,
  EnqueueInput,
  KbPatch,
  NewTicket,
  Paged,
  PageQuery,
  Repo,
  SettingsPatch,
  TenantMetrics,
  TicketFilter,
  TicketPatch,
} from './types';

/**
 * PostgreSQL(Drizzle, node-postgres Pool) 저장소.
 * - 모든 테넌트 쿼리에 tenant_id 조건을 건다(복합 FK가 DB 단에서 한 번 더 막는다).
 * - tx()는 db.transaction. 트랜잭션 안의 중첩 tx는 같은 트랜잭션에 합류.
 * - lockTicket/조건부 UPDATE로 공개답변·초안승인·워커 자동답변을 직렬화한다.
 */
type Tx = Parameters<Parameters<Database['transaction']>[0]>[0];
type Exec = Database | Tx;

const {
  tenants,
  tenantSettings,
  users,
  sessions,
  loginAttempts,
  tickets,
  ticketMessages,
  aiDrafts,
  aiRuns,
  aiJobs,
  conversations,
  conversationMessages,
  kbArticles,
  auditLog,
} = schema;

// ---------- row → domain ----------
type Row<T extends { $inferSelect: unknown }> = T['$inferSelect'];

const toTenant = (r: Row<typeof tenants>): Tenant => ({ id: r.id, slug: r.slug, name: r.name, status: r.status, createdAt: r.createdAt });
const toSettings = (r: Row<typeof tenantSettings>): TenantSettings => ({
  tenantId: r.tenantId,
  displayName: r.displayName,
  logoUrl: r.logoUrl,
  primaryColor: r.primaryColor,
  chatbotName: r.chatbotName,
  aiSystemPrompt: r.aiSystemPrompt,
  aiThreshold: r.aiThreshold,
  forbiddenCategories: r.forbiddenCategories,
  approvalMode: r.approvalMode,
  categories: r.categories,
  fallbackCategory: r.fallbackCategory,
  autoAnswerLimit: r.autoAnswerLimit,
  allowedLinkDomains: r.allowedLinkDomains,
  kbRevision: r.kbRevision,
  updatedAt: r.updatedAt,
});
const toUser = (r: Row<typeof users>): User => ({
  id: r.id,
  tenantId: r.tenantId,
  email: r.email,
  passwordHash: r.passwordHash,
  name: r.name,
  role: r.role,
  // 두 호환 컬럼 중 하나라도 비활성이면 비활성
  status: r.status === 'active' && r.isActive ? 'active' : 'disabled',
  createdAt: r.createdAt,
});
const toSession = (r: Row<typeof sessions>): Session => ({
  id: r.id,
  userId: r.userId,
  tenantId: r.tenantId,
  role: r.role,
  csrfToken: r.csrfToken,
  createdAt: r.createdAt,
  lastSeenAt: r.lastSeenAt,
  expiresAt: r.expiresAt,
  revokedAt: r.revokedAt,
  ip: r.ip,
  userAgent: r.userAgent,
});
const toTicket = (r: Row<typeof tickets>): Ticket => ({
  id: r.id,
  tenantId: r.tenantId,
  customerId: r.customerId,
  title: r.title,
  body: r.body,
  status: r.status,
  version: r.version,
  category: r.category,
  urgency: r.urgency,
  sentiment: r.sentiment,
  assigneeId: r.assigneeId,
  escalatedAt: r.escalatedAt,
  escalationReason: r.escalationReason,
  conversationId: r.conversationId,
  idempotencyKey: r.idempotencyKey,
  autoReplyCount: r.autoReplyCount,
  autoAnsweredAt: r.autoAnsweredAt,
  resolvedAt: r.resolvedAt,
  resolvedByCustomer: r.resolvedByCustomer,
  closedAt: r.closedAt,
  createdAt: r.createdAt,
  updatedAt: r.updatedAt,
});
const toMessage = (r: Row<typeof ticketMessages>): TicketMessage => ({
  id: r.id,
  tenantId: r.tenantId,
  ticketId: r.ticketId,
  authorId: r.authorId,
  role: r.role,
  // author_type이 비어 있는 행(큐 워커 작성 등)은 role로 유도
  authorType: r.authorType ?? (r.role === 'tenant_admin' ? 'agent' : r.role),
  visibility: r.visibility,
  body: r.body,
  sources: r.sources ?? null,
  draftId: r.draftId,
  sourceJobId: r.sourceJobId,
  createdAt: r.createdAt,
});
const toDraft = (r: Row<typeof aiDrafts>): AiDraft => ({
  id: r.id,
  tenantId: r.tenantId,
  ticketId: r.ticketId,
  conversationId: r.conversationId,
  jobId: r.jobId,
  runId: r.runId,
  body: r.body,
  sources: r.sources ?? null,
  status: r.status,
  version: r.version,
  decidedBy: r.decidedBy,
  decidedAt: r.decidedAt,
  rejectReason: r.rejectReason,
  sentMessageId: r.sentMessageId,
  createdAt: r.createdAt,
  updatedAt: r.updatedAt,
});
const toRun = (r: Row<typeof aiRuns>): AiRun => ({
  id: r.id,
  tenantId: r.tenantId,
  jobId: r.jobId,
  ticketId: r.ticketId,
  conversationId: r.conversationId,
  messageId: r.messageId,
  status: r.status,
  decision: r.decision,
  reason: r.reason,
  category: r.category,
  urgency: r.urgency,
  sentiment: r.sentiment,
  confidence: r.confidence,
  sources: r.sources ?? null,
  model: r.model,
  inputTokens: r.inputTokens,
  outputTokens: r.outputTokens,
  latencyMs: r.latencyMs,
  error: r.error,
  pipelineVersion: r.pipelineVersion,
  result: r.result ?? null,
  createdAt: r.createdAt,
  updatedAt: r.updatedAt,
});
const toConversation = (r: Row<typeof conversations>): Conversation => ({
  id: r.id,
  tenantId: r.tenantId,
  customerId: r.customerId,
  status: r.status,
  ticketId: r.ticketId,
  createdAt: r.createdAt,
  updatedAt: r.updatedAt,
});
const toConvMessage = (r: Row<typeof conversationMessages>): ConversationMessage => ({
  id: r.id,
  tenantId: r.tenantId,
  conversationId: r.conversationId,
  role: r.role,
  body: r.body,
  sources: r.sources ?? null,
  reason: r.reason,
  noticeCode: r.noticeCode,
  createdAt: r.createdAt,
});
const toKb = (r: Row<typeof kbArticles>): KbArticle => ({
  id: r.id,
  tenantId: r.tenantId,
  title: r.title,
  question: r.question,
  body: r.body,
  category: r.category,
  tags: r.tags,
  published: r.published,
  createdAt: r.createdAt,
  updatedAt: r.updatedAt,
});

const first = <T>(rows: T[]): T | null => rows[0] ?? null;

/** kb_articles.slug(NOT NULL, 테넌트 내 unique)는 API 입력이 아니므로 서버가 만든다. */
const kbSlug = (title: string, id: string) => {
  const base = title
    .toLowerCase()
    .normalize('NFKC')
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
  return `${base || 'article'}-${id.slice(0, 8)}`;
};

/** 고객 해결 확인 시 호환 컬럼(customer_confirmed_at)도 함께 맞춘다. */
function ticketSet(patch: TicketPatch, now: Date): PgUpdateSetSource<typeof tickets> {
  const confirmed =
    patch.resolvedByCustomer === true ? { customerConfirmedAt: patch.resolvedAt ?? now } : patch.resolvedByCustomer === false ? { customerConfirmedAt: null } : {};
  // version은 SQL 증가식(동시 갱신에도 정확) — update set 타입(PgUpdateSetSource)만 SQL 값을 허용한다
  return { ...patch, ...confirmed, updatedAt: now, version: sql`${tickets.version} + 1` };
}

export class DrizzleRepo implements Repo {
  constructor(
    private readonly db: Exec,
    private readonly inTx = false,
  ) {}

  async tx<T>(fn: (repo: Repo) => Promise<T>): Promise<T> {
    if (this.inTx) return fn(this);
    return (this.db as Database).transaction((tx) => fn(new DrizzleRepo(tx, true)));
  }

  // ---- tenants ----
  async getTenantBySlug(slug: string) {
    const r = first(await this.db.select().from(tenants).where(eq(tenants.slug, slug)).limit(1));
    return r && toTenant(r);
  }
  async listTenants() {
    return (await this.db.select().from(tenants).orderBy(tenants.slug)).map(toTenant);
  }
  async getSettings(tenantId: string) {
    const r = first(await this.db.select().from(tenantSettings).where(eq(tenantSettings.tenantId, tenantId)).limit(1));
    return r && toSettings(r);
  }
  async updateSettings(tenantId: string, patch: SettingsPatch, now: Date) {
    const r = first(
      await this.db
        .update(tenantSettings)
        .set({ ...patch, updatedAt: now, version: sql`${tenantSettings.version} + 1` })
        .where(eq(tenantSettings.tenantId, tenantId))
        .returning(),
    );
    return r && toSettings(r);
  }

  // ---- users ----
  async findUserByEmail(tenantId: string | null, email: string) {
    const r = first(
      await this.db
        .select()
        .from(users)
        .where(and(tenantId === null ? isNull(users.tenantId) : eq(users.tenantId, tenantId), sql`lower(${users.email}) = ${email.toLowerCase()}`))
        .limit(1),
    );
    return r && toUser(r);
  }
  async getUser(id: string) {
    const r = first(await this.db.select().from(users).where(eq(users.id, id)).limit(1));
    return r && toUser(r);
  }
  async getTenantUser(tenantId: string, id: string) {
    const r = first(await this.db.select().from(users).where(and(eq(users.id, id), eq(users.tenantId, tenantId))).limit(1));
    return r && toUser(r);
  }
  async createUser(u: Omit<User, 'createdAt'>, now: Date) {
    const [r] = await this.db
      .insert(users)
      .values({ ...u, email: u.email.toLowerCase(), isActive: u.status === 'active', createdAt: now, updatedAt: now })
      .returning();
    return toUser(r!);
  }
  async listStaff(tenantId: string) {
    return (
      await this.db
        .select()
        .from(users)
        .where(and(eq(users.tenantId, tenantId), inArray(users.role, ['agent', 'tenant_admin'])))
        .orderBy(users.name)
    ).map(toUser);
  }
  async updateUserStatusIf(tenantId: string, id: string, expected: User['status'], next: User['status'], now: Date) {
    const r = first(
      await this.db
        .update(users)
        .set({ status: next, isActive: next === 'active', updatedAt: now })
        .where(and(eq(users.id, id), eq(users.tenantId, tenantId), eq(users.status, expected)))
        .returning(),
    );
    return r && toUser(r);
  }
  async countOpenAssigned(tenantId: string) {
    const rows = await this.db
      .select({ assigneeId: tickets.assigneeId, n: count() })
      .from(tickets)
      .where(and(eq(tickets.tenantId, tenantId), isNotNull(tickets.assigneeId), inArray(tickets.status, ['open', 'in_progress'])))
      .groupBy(tickets.assigneeId);
    const out: Record<string, number> = {};
    for (const r of rows) if (r.assigneeId) out[r.assigneeId] = r.n;
    return out;
  }

  // ---- sessions ----
  async createSession(s: Session) {
    await this.db.insert(sessions).values(s);
    return s;
  }
  async getSession(id: string) {
    const r = first(await this.db.select().from(sessions).where(eq(sessions.id, id)).limit(1));
    return r && toSession(r);
  }
  async touchSession(id: string, lastSeenAt: Date) {
    await this.db.update(sessions).set({ lastSeenAt }).where(eq(sessions.id, id));
  }
  async revokeSession(id: string, at: Date) {
    await this.db.update(sessions).set({ revokedAt: at }).where(and(eq(sessions.id, id), isNull(sessions.revokedAt)));
  }
  async revokeUserSessions(userId: string, at: Date) {
    const rows = await this.db
      .update(sessions)
      .set({ revokedAt: at })
      .where(and(eq(sessions.userId, userId), isNull(sessions.revokedAt)))
      .returning({ id: sessions.id });
    return rows.length;
  }

  // ---- login attempts ----
  async recordLoginAttempt(a: LoginAttempt) {
    await this.db.insert(loginAttempts).values({ key: a.key, succeeded: a.succeeded, ip: a.ip, createdAt: a.createdAt });
  }
  async countFailedAttempts(key: string, since: Date) {
    const [r] = await this.db
      .select({ n: count() })
      .from(loginAttempts)
      .where(and(eq(loginAttempts.key, key), eq(loginAttempts.succeeded, false), gte(loginAttempts.createdAt, since)));
    return r?.n ?? 0;
  }

  // ---- tickets ----
  async createTicket(t: NewTicket, now: Date) {
    const [r] = await this.db.insert(tickets).values({ ...t, status: 'open', createdAt: now, updatedAt: now }).returning();
    return toTicket(r!);
  }
  async getTicket(tenantId: string, id: string) {
    const r = first(await this.db.select().from(tickets).where(and(eq(tickets.tenantId, tenantId), eq(tickets.id, id))).limit(1));
    return r && toTicket(r);
  }
  async findTicketByIdempotencyKey(tenantId: string, customerId: string, key: string) {
    const r = first(
      await this.db
        .select()
        .from(tickets)
        .where(and(eq(tickets.tenantId, tenantId), eq(tickets.customerId, customerId), eq(tickets.idempotencyKey, key)))
        .limit(1),
    );
    return r && toTicket(r);
  }
  async lockTicket(tenantId: string, id: string) {
    const r = first(await this.db.select().from(tickets).where(and(eq(tickets.tenantId, tenantId), eq(tickets.id, id))).for('update'));
    return r && toTicket(r);
  }
  async findTicketByConversation(tenantId: string, conversationId: string) {
    const r = first(
      await this.db.select().from(tickets).where(and(eq(tickets.tenantId, tenantId), eq(tickets.conversationId, conversationId))).limit(1),
    );
    return r && toTicket(r);
  }
  async listTickets(tenantId: string, f: TicketFilter, p: PageQuery): Promise<Paged<Ticket>> {
    const conds: SQL[] = [eq(tickets.tenantId, tenantId)];
    if (f.customerId) conds.push(eq(tickets.customerId, f.customerId));
    if (f.status) conds.push(eq(tickets.status, f.status));
    if (f.category) conds.push(eq(tickets.category, f.category));
    if (f.urgency) conds.push(eq(tickets.urgency, f.urgency));
    if (f.sentiment) conds.push(eq(tickets.sentiment, f.sentiment));
    if (f.assigneeId === 'none') conds.push(isNull(tickets.assigneeId));
    else if (f.assigneeId) conds.push(eq(tickets.assigneeId, f.assigneeId));
    if (f.escalated === true) conds.push(isNotNull(tickets.escalatedAt));
    if (f.escalated === false) conds.push(isNull(tickets.escalatedAt));
    const where = and(...conds);
    const [rows, [total]] = await Promise.all([
      this.db
        .select()
        .from(tickets)
        .where(where)
        .orderBy(desc(tickets.updatedAt), desc(tickets.id))
        .limit(p.pageSize)
        .offset((p.page - 1) * p.pageSize),
      this.db.select({ n: count() }).from(tickets).where(where),
    ]);
    return { items: rows.map(toTicket), page: p.page, pageSize: p.pageSize, total: total?.n ?? 0 };
  }
  async updateTicket(tenantId: string, id: string, patch: TicketPatch, now: Date) {
    const r = first(
      await this.db
        .update(tickets)
        .set(ticketSet(patch, now))
        .where(and(eq(tickets.tenantId, tenantId), eq(tickets.id, id)))
        .returning(),
    );
    return r && toTicket(r);
  }
  async updateTicketIfVersion(tenantId: string, id: string, expectedVersion: number, patch: TicketPatch, now: Date) {
    const r = first(
      await this.db
        .update(tickets)
        .set(ticketSet(patch, now))
        .where(and(eq(tickets.tenantId, tenantId), eq(tickets.id, id), eq(tickets.version, expectedVersion)))
        .returning(),
    );
    return r && toTicket(r);
  }

  // ---- messages ----
  async addTicketMessage(m: Omit<TicketMessage, 'createdAt'>, now: Date) {
    const [r] = await this.db.insert(ticketMessages).values({ ...m, createdAt: now }).returning();
    return toMessage(r!);
  }
  async listTicketMessages(tenantId: string, ticketId: string) {
    return (
      await this.db
        .select()
        .from(ticketMessages)
        .where(and(eq(ticketMessages.tenantId, tenantId), eq(ticketMessages.ticketId, ticketId)))
        .orderBy(ticketMessages.createdAt, ticketMessages.id)
    ).map(toMessage);
  }

  // ---- drafts & runs ----
  async createDraft(d: Omit<AiDraft, 'createdAt' | 'updatedAt'>, now: Date) {
    if (!d.jobId) throw new Error('ai_drafts.job_id is required');
    const [r] = await this.db
      .insert(aiDrafts)
      .values({ ...d, jobId: d.jobId, createdAt: now, updatedAt: now })
      .returning();
    return toDraft(r!);
  }
  async getDraft(tenantId: string, id: string) {
    const r = first(await this.db.select().from(aiDrafts).where(and(eq(aiDrafts.tenantId, tenantId), eq(aiDrafts.id, id))).limit(1));
    return r && toDraft(r);
  }
  async listDrafts(tenantId: string, ticketId: string) {
    return (
      await this.db
        .select()
        .from(aiDrafts)
        .where(and(eq(aiDrafts.tenantId, tenantId), eq(aiDrafts.ticketId, ticketId)))
        .orderBy(desc(aiDrafts.createdAt))
    ).map(toDraft);
  }
  async updateDraftIfVersion(tenantId: string, id: string, expectedVersion: number, allowed: DraftStatus[], patch: DraftPatch, now: Date) {
    const r = first(
      await this.db
        .update(aiDrafts)
        .set({ ...patch, updatedAt: now, version: sql`${aiDrafts.version} + 1` })
        .where(
          and(eq(aiDrafts.tenantId, tenantId), eq(aiDrafts.id, id), eq(aiDrafts.version, expectedVersion), inArray(aiDrafts.status, allowed)),
        )
        .returning(),
    );
    return r && toDraft(r);
  }
  async listRuns(tenantId: string, ticketId: string, conversationId?: string | null) {
    const target = conversationId ? or(eq(aiRuns.ticketId, ticketId), eq(aiRuns.conversationId, conversationId)) : eq(aiRuns.ticketId, ticketId);
    return (await this.db.select().from(aiRuns).where(and(eq(aiRuns.tenantId, tenantId), target)).orderBy(desc(aiRuns.createdAt))).map(toRun);
  }
  async createRun(run: Omit<AiRun, 'createdAt' | 'updatedAt'>, now: Date) {
    const [r] = await this.db
      .insert(aiRuns)
      .values({ ...run, pipelineVersion: run.pipelineVersion ?? 'v1', createdAt: now, updatedAt: now })
      .returning();
    return toRun(r!);
  }
  async saveConversationDraft(
    d: { id: string; tenantId: string; conversationId: string; runId: string; body: string; sources: AiDraft['sources'] },
    now: Date,
  ) {
    const existing = first(
      await this.db
        .select()
        .from(aiDrafts)
        .where(and(eq(aiDrafts.tenantId, d.tenantId), eq(aiDrafts.conversationId, d.conversationId)))
        .for('update')
        .limit(1),
    );
    if (!existing) {
      const [r] = await this.db
        .insert(aiDrafts)
        .values({ ...d, ticketId: null, jobId: null, status: 'draft', version: 1, createdAt: now, updatedAt: now })
        .returning();
      return toDraft(r!);
    }
    const r = first(
      await this.db
        .update(aiDrafts)
        .set({ body: d.body, sources: d.sources, runId: d.runId, status: 'draft', version: sql`${aiDrafts.version} + 1`, updatedAt: now })
        .where(and(eq(aiDrafts.id, existing.id), isNull(aiDrafts.ticketId), inArray(aiDrafts.status, ['draft', 'approved'])))
        .returning(),
    );
    return toDraft(r ?? existing);
  }
  async attachConversationDrafts(tenantId: string, conversationId: string, ticketId: string, now: Date) {
    const rows = await this.db
      .update(aiDrafts)
      .set({ ticketId, updatedAt: now })
      .where(and(eq(aiDrafts.tenantId, tenantId), eq(aiDrafts.conversationId, conversationId), isNull(aiDrafts.ticketId)))
      .returning({ id: aiDrafts.id });
    return rows.length;
  }

  // ---- jobs: @support/queue 생산자 헬퍼를 같은 트랜잭션 executor로 호출 ----
  async enqueueJob(input: EnqueueInput, _now: Date) {
    const jobId = await enqueueInquiry(this.db, {
      tenantId: input.tenantId,
      ticketId: input.ticketId,
      messageId: input.messageId,
      kind: input.kind,
      idempotencyKey: input.idempotencyKey,
      pipelineVersion: input.pipelineVersion,
      maxAttempts: input.maxAttempts,
    });
    return { jobId };
  }
  async findActiveJob(tenantId: string, ticketId: string, kind: JobKind) {
    return first(
      await this.db
        .select({ id: aiJobs.id })
        .from(aiJobs)
        .where(
          and(eq(aiJobs.tenantId, tenantId), eq(aiJobs.ticketId, ticketId), eq(aiJobs.kind, kind), inArray(aiJobs.status, ['queued', 'processing'])),
        )
        .limit(1),
    );
  }

  // ---- conversations ----
  async createConversation(c: Omit<Conversation, 'createdAt' | 'updatedAt'>, now: Date) {
    const [r] = await this.db.insert(conversations).values({ ...c, createdAt: now, updatedAt: now }).returning();
    return toConversation(r!);
  }
  async getConversation(tenantId: string, id: string) {
    const r = first(await this.db.select().from(conversations).where(and(eq(conversations.tenantId, tenantId), eq(conversations.id, id))).limit(1));
    return r && toConversation(r);
  }
  async updateConversationIfStatus(
    tenantId: string,
    id: string,
    expectedStatus: ConversationStatus,
    patch: Partial<Pick<Conversation, 'status' | 'ticketId'>>,
    now: Date,
  ) {
    const r = first(
      await this.db
        .update(conversations)
        .set({ ...patch, updatedAt: now })
        .where(and(eq(conversations.tenantId, tenantId), eq(conversations.id, id), eq(conversations.status, expectedStatus)))
        .returning(),
    );
    return r && toConversation(r);
  }
  async addConversationMessage(m: Omit<ConversationMessage, 'createdAt'>, now: Date) {
    const [r] = await this.db.insert(conversationMessages).values({ ...m, createdAt: now }).returning();
    await this.db
      .update(conversations)
      .set({ updatedAt: now })
      .where(and(eq(conversations.tenantId, m.tenantId), eq(conversations.id, m.conversationId)));
    return toConvMessage(r!);
  }
  async listConversationMessages(tenantId: string, conversationId: string) {
    return (
      await this.db
        .select()
        .from(conversationMessages)
        .where(and(eq(conversationMessages.tenantId, tenantId), eq(conversationMessages.conversationId, conversationId)))
        .orderBy(conversationMessages.createdAt, conversationMessages.id)
    ).map(toConvMessage);
  }

  // ---- kb ----
  async listKb(tenantId: string) {
    return (await this.db.select().from(kbArticles).where(eq(kbArticles.tenantId, tenantId)).orderBy(desc(kbArticles.updatedAt))).map(toKb);
  }
  async getKb(tenantId: string, id: string) {
    const r = first(await this.db.select().from(kbArticles).where(and(eq(kbArticles.tenantId, tenantId), eq(kbArticles.id, id))).limit(1));
    return r && toKb(r);
  }
  async createKb(a: Omit<KbArticle, 'createdAt' | 'updatedAt'>, now: Date) {
    const [r] = await this.db
      .insert(kbArticles)
      .values({ ...a, slug: kbSlug(a.title, a.id), createdAt: now, updatedAt: now })
      .returning();
    await this.bumpKbRevision(a.tenantId);
    return toKb(r!);
  }
  async updateKb(tenantId: string, id: string, patch: KbPatch, now: Date) {
    const r = first(
      await this.db
        .update(kbArticles)
        .set({ ...patch, updatedAt: now, revision: sql`${kbArticles.revision} + 1` })
        .where(and(eq(kbArticles.tenantId, tenantId), eq(kbArticles.id, id)))
        .returning(),
    );
    if (r) await this.bumpKbRevision(tenantId);
    return r && toKb(r);
  }
  async deleteKb(tenantId: string, id: string) {
    const rows = await this.db
      .delete(kbArticles)
      .where(and(eq(kbArticles.tenantId, tenantId), eq(kbArticles.id, id)))
      .returning({ id: kbArticles.id });
    if (rows.length > 0) await this.bumpKbRevision(tenantId);
    return rows.length > 0;
  }
  /** KB 변경과 같은 실행기(tx)에서 테넌트 KB 버전 +1(web·worker 캐시가 다음 검색에서 다시 읽음) */
  private async bumpKbRevision(tenantId: string) {
    await this.db
      .update(tenantSettings)
      .set({ kbRevision: sql`${tenantSettings.kbRevision} + 1` })
      .where(eq(tenantSettings.tenantId, tenantId));
  }

  // ---- audit & metrics ----
  async audit(e: AuditEntry, now: Date) {
    await this.db.insert(auditLog).values({
      id: randomUUID(),
      tenantId: e.tenantId,
      actorId: e.actorId,
      action: e.action,
      targetType: e.targetType,
      targetId: e.targetId,
      meta: e.meta ?? {},
      createdAt: now,
    });
  }

  async tenantMetrics(tenantId: string): Promise<TenantMetrics> {
    const byStatusRows = await this.db
      .select({ status: tickets.status, n: count() })
      .from(tickets)
      .where(eq(tickets.tenantId, tenantId))
      .groupBy(tickets.status);
    const ticketsByStatus: Record<TicketStatus, number> = { open: 0, in_progress: 0, resolved: 0, closed: 0 };
    for (const r of byStatusRows) ticketsByStatus[r.status] = r.n;

    const staffPublicReply = sql`exists (select 1 from ${ticketMessages} m where m.tenant_id = ${tickets.tenantId} and m.ticket_id = ${tickets.id} and m.visibility = 'public' and m.role in ('agent','tenant_admin'))`;
    const autoAnswered = sql`(${tickets.autoReplyCount} > 0 or ${tickets.autoAnsweredAt} is not null)`;
    const [agg] = await this.db
      .select({
        total: count(),
        escalated: sql<number>`count(*) filter (where ${tickets.escalatedAt} is not null)`.mapWith(Number),
        autoAnswered: sql<number>`count(*) filter (where ${autoAnswered})`.mapWith(Number),
        autoResolved: sql<number>`count(*) filter (where ${autoAnswered} and ${tickets.resolvedByCustomer} and not ${staffPublicReply})`.mapWith(Number),
      })
      .from(tickets)
      .where(eq(tickets.tenantId, tenantId));

    const catRows = await this.db
      .select({ category: sql<string>`coalesce(${tickets.category}, 'uncategorized')`, n: count() })
      .from(tickets)
      .where(eq(tickets.tenantId, tenantId))
      .groupBy(sql`coalesce(${tickets.category}, 'uncategorized')`);

    const [runs] = await this.db
      .select({ total: count(), failed: sql<number>`count(*) filter (where ${aiRuns.status} = 'failed')`.mapWith(Number) })
      .from(aiRuns)
      .where(eq(aiRuns.tenantId, tenantId));

    return {
      tenantId,
      ticketsTotal: agg?.total ?? 0,
      ticketsByStatus,
      escalatedTickets: agg?.escalated ?? 0,
      autoAnsweredTickets: agg?.autoAnswered ?? 0,
      autoResolvedTickets: agg?.autoResolved ?? 0,
      categoryDistribution: Object.fromEntries(catRows.map((r) => [r.category, r.n])),
      aiRunsTotal: runs?.total ?? 0,
      aiRunsFailed: runs?.failed ?? 0,
    };
  }
}
