import { randomUUID } from 'node:crypto';
import type {
  AiDraft,
  AiRun,
  AuditEntry,
  Conversation,
  ConversationStatus,
  ConversationMessage,
  DraftStatus,
  JobKind,
  JobStatus,
  KbArticle,
  LoginAttempt,
  Session,
  Tenant,
  TenantSettings,
  Ticket,
  TicketMessage,
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
 * 테스트·DB 없는 로컬 확인용 메모리 저장소. Drizzle 구현과 같은 계약을 지킨다.
 * tx()는 전역 뮤텍스로 직렬화하고(= 행 잠금보다 강함), 예외 시 스냅샷으로 롤백한다.
 */
export interface MemoryJob {
  id: string;
  tenantId: string;
  kind: JobKind;
  ticketId: string;
  messageId: string | null;
  idempotencyKey: string;
  pipelineVersion: string;
  status: JobStatus;
  maxAttempts: number;
  createdAt: Date;
}

interface State {
  tenants: Tenant[];
  settings: TenantSettings[];
  users: User[];
  sessions: Session[];
  loginAttempts: LoginAttempt[];
  tickets: Ticket[];
  ticketMessages: TicketMessage[];
  drafts: AiDraft[];
  runs: AiRun[];
  jobs: MemoryJob[];
  conversations: Conversation[];
  conversationMessages: ConversationMessage[];
  kb: KbArticle[];
  audit: Array<AuditEntry & { createdAt: Date }>;
}

const emptyState = (): State => ({
  tenants: [],
  settings: [],
  users: [],
  sessions: [],
  loginAttempts: [],
  tickets: [],
  ticketMessages: [],
  drafts: [],
  runs: [],
  jobs: [],
  conversations: [],
  conversationMessages: [],
  kb: [],
  audit: [],
});

const clone = <T>(v: T): T => structuredClone(v);
const uniqueError = (what: string) => Object.assign(new Error(`unique violation ${what}`), { code: '23505' });
const byCreated = <T extends { createdAt: Date }>(a: T, b: T) => a.createdAt.getTime() - b.createdAt.getTime();

export class MemoryRepo implements Repo {
  state: State = emptyState();
  private lock: Promise<void> = Promise.resolve();

  async tx<T>(fn: (repo: Repo) => Promise<T>): Promise<T> {
    let release!: () => void;
    const prev = this.lock;
    this.lock = new Promise<void>((r) => (release = r));
    await prev;
    const snapshot = clone(this.state);
    // 트랜잭션 내부의 중첩 tx는 같은 트랜잭션으로 합류한다.
    const inner: MemoryRepo = Object.create(this);
    inner.tx = (f) => f(inner);
    try {
      return await fn(inner);
    } catch (e) {
      this.state = snapshot;
      throw e;
    } finally {
      release();
    }
  }

  // ---- tenants ----
  async getTenantBySlug(slug: string) {
    return clone(this.state.tenants.find((t) => t.slug === slug) ?? null);
  }
  async listTenants() {
    return clone(this.state.tenants);
  }
  async getSettings(tenantId: string) {
    return clone(this.state.settings.find((s) => s.tenantId === tenantId) ?? null);
  }
  async updateSettings(tenantId: string, patch: SettingsPatch, now: Date) {
    const s = this.state.settings.find((x) => x.tenantId === tenantId);
    if (!s) return null;
    Object.assign(s, patch, { updatedAt: now });
    return clone(s);
  }

  // ---- users ----
  async findUserByEmail(tenantId: string | null, email: string) {
    const e = email.toLowerCase();
    return clone(this.state.users.find((u) => u.tenantId === tenantId && u.email === e) ?? null);
  }
  async getUser(id: string) {
    return clone(this.state.users.find((u) => u.id === id) ?? null);
  }
  async getTenantUser(tenantId: string, id: string) {
    return clone(this.state.users.find((u) => u.id === id && u.tenantId === tenantId) ?? null);
  }
  async createUser(user: Omit<User, 'createdAt'>, now: Date) {
    if (this.state.users.some((u) => u.tenantId === user.tenantId && u.email === user.email)) {
      throw uniqueError('users(tenant_id, email)');
    }
    const row: User = { ...user, createdAt: now };
    this.state.users.push(row);
    return clone(row);
  }
  async listStaff(tenantId: string) {
    return clone(this.state.users.filter((u) => u.tenantId === tenantId && (u.role === 'agent' || u.role === 'tenant_admin')));
  }
  async updateUserStatusIf(tenantId: string, id: string, expected: User['status'], next: User['status'], _now: Date) {
    const u = this.state.users.find((x) => x.id === id && x.tenantId === tenantId && x.status === expected);
    if (!u) return null;
    u.status = next;
    return clone(u);
  }
  async countOpenAssigned(tenantId: string) {
    const out: Record<string, number> = {};
    for (const t of this.state.tickets) {
      if (t.tenantId === tenantId && t.assigneeId && (t.status === 'open' || t.status === 'in_progress')) out[t.assigneeId] = (out[t.assigneeId] ?? 0) + 1;
    }
    return out;
  }

  // ---- sessions ----
  async createSession(s: Session) {
    this.state.sessions.push(clone(s));
    return clone(s);
  }
  async getSession(id: string) {
    return clone(this.state.sessions.find((s) => s.id === id) ?? null);
  }
  async touchSession(id: string, lastSeenAt: Date) {
    const s = this.state.sessions.find((x) => x.id === id);
    if (s) s.lastSeenAt = lastSeenAt;
  }
  async revokeSession(id: string, at: Date) {
    const s = this.state.sessions.find((x) => x.id === id);
    if (s && !s.revokedAt) s.revokedAt = at;
  }
  async revokeUserSessions(userId: string, at: Date) {
    const live = this.state.sessions.filter((s) => s.userId === userId && !s.revokedAt);
    for (const s of live) s.revokedAt = at;
    return live.length;
  }

  // ---- login attempts ----
  async recordLoginAttempt(a: LoginAttempt) {
    this.state.loginAttempts.push(clone(a));
  }
  async countFailedAttempts(key: string, since: Date) {
    return this.state.loginAttempts.filter((a) => a.key === key && !a.succeeded && a.createdAt >= since).length;
  }

  // ---- tickets ----
  async createTicket(t: NewTicket, now: Date) {
    if (t.conversationId && this.state.tickets.some((x) => x.conversationId === t.conversationId)) {
      throw uniqueError('tickets(conversation_id)');
    }
    if (
      t.idempotencyKey &&
      this.state.tickets.some((x) => x.tenantId === t.tenantId && x.customerId === t.customerId && x.idempotencyKey === t.idempotencyKey)
    ) {
      throw uniqueError('tickets(tenant_id, customer_id, idempotency_key)');
    }
    const row: Ticket = {
      ...t,
      status: 'open',
      version: 1,
      category: null,
      urgency: null,
      sentiment: null,
      assigneeId: null,
      escalatedAt: null,
      escalationReason: null,
      autoReplyCount: 0,
      autoAnsweredAt: null,
      resolvedAt: null,
      resolvedByCustomer: false,
      closedAt: null,
      createdAt: now,
      updatedAt: now,
    };
    this.state.tickets.push(row);
    return clone(row);
  }
  async getTicket(tenantId: string, id: string) {
    return clone(this.state.tickets.find((t) => t.id === id && t.tenantId === tenantId) ?? null);
  }
  async findTicketByIdempotencyKey(tenantId: string, customerId: string, key: string) {
    return clone(
      this.state.tickets.find((t) => t.tenantId === tenantId && t.customerId === customerId && t.idempotencyKey === key) ?? null,
    );
  }
  async lockTicket(tenantId: string, id: string) {
    return this.getTicket(tenantId, id);
  }
  async findTicketByConversation(tenantId: string, conversationId: string) {
    return clone(this.state.tickets.find((t) => t.tenantId === tenantId && t.conversationId === conversationId) ?? null);
  }
  async listTickets(tenantId: string, f: TicketFilter, p: PageQuery): Promise<Paged<Ticket>> {
    const rows = this.state.tickets
      .filter((t) => t.tenantId === tenantId)
      .filter((t) => !f.customerId || t.customerId === f.customerId)
      .filter((t) => !f.status || t.status === f.status)
      .filter((t) => !f.category || t.category === f.category)
      .filter((t) => !f.urgency || t.urgency === f.urgency)
      .filter((t) => !f.sentiment || t.sentiment === f.sentiment)
      .filter((t) => (f.assigneeId === undefined ? true : f.assigneeId === 'none' ? t.assigneeId === null : t.assigneeId === f.assigneeId))
      .filter((t) => (f.escalated === undefined ? true : (t.escalatedAt !== null) === f.escalated))
      .sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime() || b.id.localeCompare(a.id));
    const start = (p.page - 1) * p.pageSize;
    return { items: clone(rows.slice(start, start + p.pageSize)), page: p.page, pageSize: p.pageSize, total: rows.length };
  }
  async updateTicket(tenantId: string, id: string, patch: TicketPatch, now: Date) {
    const t = this.state.tickets.find((x) => x.id === id && x.tenantId === tenantId);
    if (!t) return null;
    Object.assign(t, patch, { version: t.version + 1, updatedAt: now });
    return clone(t);
  }
  async updateTicketIfVersion(tenantId: string, id: string, expectedVersion: number, patch: TicketPatch, now: Date) {
    const t = this.state.tickets.find((x) => x.id === id && x.tenantId === tenantId);
    if (!t || t.version !== expectedVersion) return null;
    return this.updateTicket(tenantId, id, patch, now);
  }

  // ---- messages ----
  async addTicketMessage(m: Omit<TicketMessage, 'createdAt'>, now: Date) {
    if (m.sourceJobId && this.state.ticketMessages.some((x) => x.sourceJobId === m.sourceJobId)) {
      throw uniqueError('ticket_messages(source_job_id)');
    }
    const row = { ...m, createdAt: now };
    this.state.ticketMessages.push(row);
    return clone(row);
  }
  async listTicketMessages(tenantId: string, ticketId: string) {
    return clone(this.state.ticketMessages.filter((m) => m.tenantId === tenantId && m.ticketId === ticketId).sort(byCreated));
  }

  // ---- drafts & runs ----
  async createDraft(d: Omit<AiDraft, 'createdAt' | 'updatedAt'>, now: Date) {
    const row = { ...d, createdAt: now, updatedAt: now };
    this.state.drafts.push(row);
    return clone(row);
  }
  async getDraft(tenantId: string, id: string) {
    return clone(this.state.drafts.find((d) => d.id === id && d.tenantId === tenantId) ?? null);
  }
  async listDrafts(tenantId: string, ticketId: string) {
    return clone(this.state.drafts.filter((d) => d.tenantId === tenantId && d.ticketId === ticketId).sort(byCreated).reverse());
  }
  async updateDraftIfVersion(
    tenantId: string,
    id: string,
    expectedVersion: number,
    allowed: DraftStatus[],
    patch: DraftPatch,
    now: Date,
  ) {
    const d = this.state.drafts.find((x) => x.id === id && x.tenantId === tenantId);
    if (!d || d.version !== expectedVersion || !allowed.includes(d.status)) return null;
    Object.assign(d, patch, { version: d.version + 1, updatedAt: now });
    return clone(d);
  }
  async listRuns(tenantId: string, ticketId: string, conversationId?: string | null) {
    return clone(
      this.state.runs
        .filter((r) => r.tenantId === tenantId && (r.ticketId === ticketId || (!!conversationId && r.conversationId === conversationId)))
        .sort(byCreated)
        .reverse(),
    );
  }
  async createRun(run: Omit<AiRun, 'createdAt' | 'updatedAt'>, now: Date) {
    const dup = this.state.runs.some(
      (r) =>
        r.jobId === null &&
        run.jobId === null &&
        r.tenantId === run.tenantId &&
        r.conversationId === run.conversationId &&
        r.messageId === run.messageId &&
        r.pipelineVersion === run.pipelineVersion,
    );
    if (dup) throw uniqueError('ai_runs_sse_conversation_message');
    const row: AiRun = { ...run, createdAt: now, updatedAt: now };
    this.state.runs.push(row);
    return clone(row);
  }
  async saveConversationDraft(
    d: { id: string; tenantId: string; conversationId: string; runId: string; body: string; sources: AiDraft['sources'] },
    now: Date,
  ) {
    const existing = this.state.drafts.find((x) => x.tenantId === d.tenantId && x.conversationId === d.conversationId);
    if (!existing) {
      const row: AiDraft = {
        ...d,
        ticketId: null,
        jobId: null,
        status: 'draft',
        version: 1,
        decidedBy: null,
        decidedAt: null,
        rejectReason: null,
        sentMessageId: null,
        createdAt: now,
        updatedAt: now,
      };
      this.state.drafts.push(row);
      return clone(row);
    }
    if (existing.ticketId === null && (existing.status === 'draft' || existing.status === 'approved')) {
      Object.assign(existing, { body: d.body, sources: d.sources, runId: d.runId, status: 'draft', version: existing.version + 1, updatedAt: now });
    }
    return clone(existing);
  }
  async attachConversationDrafts(tenantId: string, conversationId: string, ticketId: string, now: Date) {
    const ds = this.state.drafts.filter((d) => d.tenantId === tenantId && d.conversationId === conversationId && d.ticketId === null);
    for (const d of ds) Object.assign(d, { ticketId, updatedAt: now });
    return ds.length;
  }

  // ---- jobs ----
  async enqueueJob(input: EnqueueInput, now: Date) {
    const existing = this.state.jobs.find((j) => j.tenantId === input.tenantId && j.idempotencyKey === input.idempotencyKey);
    if (existing) return { jobId: existing.id };
    const job: MemoryJob = { ...input, id: randomUUID(), status: 'queued', createdAt: now };
    this.state.jobs.push(job);
    return { jobId: job.id };
  }
  async findActiveJob(tenantId: string, ticketId: string, kind: JobKind) {
    const j = this.state.jobs.find(
      (x) => x.tenantId === tenantId && x.ticketId === ticketId && x.kind === kind && (x.status === 'queued' || x.status === 'processing'),
    );
    return j ? { id: j.id } : null;
  }

  // ---- conversations ----
  async createConversation(c: Omit<Conversation, 'createdAt' | 'updatedAt'>, now: Date) {
    const row = { ...c, createdAt: now, updatedAt: now };
    this.state.conversations.push(row);
    return clone(row);
  }
  async getConversation(tenantId: string, id: string) {
    return clone(this.state.conversations.find((c) => c.id === id && c.tenantId === tenantId) ?? null);
  }
  async updateConversationIfStatus(
    tenantId: string,
    id: string,
    expectedStatus: ConversationStatus,
    patch: Partial<Pick<Conversation, 'status' | 'ticketId'>>,
    now: Date,
  ) {
    const c = this.state.conversations.find((x) => x.id === id && x.tenantId === tenantId);
    if (!c || c.status !== expectedStatus) return null;
    Object.assign(c, patch, { updatedAt: now });
    return clone(c);
  }
  async addConversationMessage(m: Omit<ConversationMessage, 'createdAt'>, now: Date) {
    const row = { ...m, createdAt: now };
    this.state.conversationMessages.push(row);
    const c = this.state.conversations.find((x) => x.id === m.conversationId && x.tenantId === m.tenantId);
    if (c) c.updatedAt = now;
    return clone(row);
  }
  async listConversationMessages(tenantId: string, conversationId: string) {
    return clone(this.state.conversationMessages.filter((m) => m.tenantId === tenantId && m.conversationId === conversationId).sort(byCreated));
  }

  // ---- kb ----
  async listKb(tenantId: string) {
    return clone(this.state.kb.filter((a) => a.tenantId === tenantId));
  }
  async getKb(tenantId: string, id: string) {
    return clone(this.state.kb.find((a) => a.id === id && a.tenantId === tenantId) ?? null);
  }
  async createKb(a: Omit<KbArticle, 'createdAt' | 'updatedAt'>, now: Date) {
    const row = { ...a, createdAt: now, updatedAt: now };
    this.state.kb.push(row);
    this.bumpKbRevision(a.tenantId);
    return clone(row);
  }
  async updateKb(tenantId: string, id: string, patch: KbPatch, now: Date) {
    const a = this.state.kb.find((x) => x.id === id && x.tenantId === tenantId);
    if (!a) return null;
    Object.assign(a, patch, { updatedAt: now });
    this.bumpKbRevision(tenantId);
    return clone(a);
  }
  async deleteKb(tenantId: string, id: string) {
    const i = this.state.kb.findIndex((x) => x.id === id && x.tenantId === tenantId);
    if (i < 0) return false;
    this.state.kb.splice(i, 1);
    this.bumpKbRevision(tenantId);
    return true;
  }
  private bumpKbRevision(tenantId: string) {
    const s = this.state.settings.find((x) => x.tenantId === tenantId);
    if (s) s.kbRevision += 1;
  }

  // ---- audit & metrics ----
  async audit(e: AuditEntry, now: Date) {
    this.state.audit.push({ ...e, createdAt: now });
  }
  async tenantMetrics(tenantId: string): Promise<TenantMetrics> {
    const tickets = this.state.tickets.filter((t) => t.tenantId === tenantId);
    const byStatus = { open: 0, in_progress: 0, resolved: 0, closed: 0 };
    const categoryDistribution: Record<string, number> = {};
    let autoResolved = 0;
    for (const t of tickets) {
      byStatus[t.status]++;
      const c = t.category ?? 'uncategorized';
      categoryDistribution[c] = (categoryDistribution[c] ?? 0) + 1;
      if (t.autoReplyCount > 0 && t.resolvedByCustomer) {
        const staffReplied = this.state.ticketMessages.some(
          (m) => m.ticketId === t.id && m.authorType === 'agent' && m.visibility === 'public',
        );
        if (!staffReplied) autoResolved++;
      }
    }
    const runs = this.state.runs.filter((r) => r.tenantId === tenantId);
    return {
      tenantId,
      ticketsTotal: tickets.length,
      ticketsByStatus: byStatus,
      escalatedTickets: tickets.filter((t) => t.escalatedAt).length,
      autoAnsweredTickets: tickets.filter((t) => t.autoReplyCount > 0).length,
      autoResolvedTickets: autoResolved,
      categoryDistribution,
      aiRunsTotal: runs.length,
      aiRunsFailed: runs.filter((r) => r.status === 'failed').length,
    };
  }
}
