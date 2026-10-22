import { sql } from 'drizzle-orm';
import { pgTable, uuid, text, integer, boolean, timestamp, jsonb, doublePrecision, unique, uniqueIndex, index, check, foreignKey } from 'drizzle-orm/pg-core';

export interface Source { kbArticleId: string; title: string; excerpt?: string; tenantId?: string }
/** 고객 공개 메시지(ticket_messages·conversation_messages)의 근거. 내부 Source(kbArticleId·tenantId·점수)는 ai_runs·ai_drafts에만 */
export interface PublicSource { id: string; title: string; excerpt?: string; url?: string }
export interface CategoryDefinition { id: string; label: string; keywords: string[]; description?: string }

const id = () => uuid('id').primaryKey().defaultRandom();
const tenantId = () => uuid('tenant_id').notNull().references(() => tenants.id);
const createdAt = () => timestamp('created_at', { withTimezone: true }).notNull().defaultNow();
const updatedAt = () => timestamp('updated_at', { withTimezone: true }).notNull().defaultNow();
const time = (name: string) => timestamp(name, { withTimezone: true });
export const tenants = pgTable('tenants', {
  id: id(), slug: text('slug').notNull().unique(), name: text('name').notNull(),
  status: text('status', { enum: ['active', 'suspended'] }).notNull().default('active'), createdAt: createdAt(), updatedAt: updatedAt(),
}, t => [check('tenant_status', sql`${t.status} in ('active','suspended')`)]);
export const tenantSettings = pgTable('tenant_settings', {
  tenantId: tenantId().primaryKey(), approvalMode: boolean('approval_mode').notNull().default(false),
  aiThreshold: doublePrecision('ai_threshold').notNull().default(0.85),
  displayName: text('display_name').notNull().default(''), logoUrl: text('logo_url'), primaryColor: text('primary_color'), chatbotName: text('chatbot_name').notNull().default('Support Bot'), aiSystemPrompt: text('ai_system_prompt').notNull().default(''), categories: jsonb('categories').$type<CategoryDefinition[]>().notNull().default([{ id: 'other', label: '기타', keywords: [] }]), version: integer('version').notNull().default(1),
  autoAnswerLimit: integer('auto_answer_limit').notNull().default(1), fallbackCategory: text('fallback_category').notNull(), kbRevision: integer('kb_revision').notNull().default(0),
  forbiddenCategories: jsonb('forbidden_categories').$type<string[]>().notNull().default([]),
  allowedLinkDomains: jsonb('allowed_link_domains').$type<string[]>().notNull().default([]), updatedAt: updatedAt(),
}, t => [check('settings_kb_revision', sql`${t.kbRevision} >= 0`), check('confidence_range', sql`${t.aiThreshold} between 0 and 1`), check('settings_auto_answer_limit', sql`${t.autoAnswerLimit} = 1`)]);
export const users = pgTable('users', {
  id: id(), tenantId: uuid('tenant_id').references(() => tenants.id), email: text('email').notNull(), name: text('name').notNull(), passwordHash: text('password_hash').notNull(),
  role: text('role', { enum: ['customer', 'agent', 'tenant_admin', 'platform_admin'] }).notNull(), status: text('status', { enum: ['active', 'disabled'] }).notNull().default('active'), isActive: boolean('is_active').notNull().default(true), createdAt: createdAt(), updatedAt: updatedAt(),
}, t => [unique('users_tenant_id_id').on(t.tenantId, t.id), uniqueIndex('users_tenant_email').on(t.tenantId, sql`lower(${t.email})`).where(sql`${t.tenantId} is not null`), uniqueIndex('users_platform_email').on(sql`lower(${t.email})`).where(sql`${t.tenantId} is null`), check('user_role_tenant', sql`(${t.role} = 'platform_admin' and ${t.tenantId} is null) or (${t.role} in ('customer','agent','tenant_admin') and ${t.tenantId} is not null)`)]);
export const sessions = pgTable('sessions', {
  id: text('id').primaryKey(), userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }), tenantId: uuid('tenant_id').references(() => tenants.id), role: text('role', { enum: ['customer', 'agent', 'tenant_admin', 'platform_admin'] }).notNull(), csrfToken: text('csrf_token').notNull(), lastSeenAt: time('last_seen_at').notNull().defaultNow(), revokedAt: time('revoked_at'), ip: text('ip'), userAgent: text('user_agent'), expiresAt: time('expires_at').notNull(), createdAt: createdAt(),
}, t => [index('sessions_expiry').on(t.expiresAt)]);
export const loginAttempts = pgTable('login_attempts', {
  id: id(), tenantId: uuid('tenant_id').references(() => tenants.id), email: text('email').notNull().default(''), ipHash: text('ip_hash').notNull().default(''), key: text('key').notNull(), succeeded: boolean('succeeded').notNull().default(false), ip: text('ip'), createdAt: createdAt(),
}, t => [index('login_attempts_lookup').on(t.email, t.ipHash, t.createdAt), index('login_attempts_key').on(t.key, t.createdAt)]);
export const conversations = pgTable('conversations', {
  id: id(), tenantId: tenantId(), customerId: uuid('customer_id').notNull(), status: text('status', { enum: ['open', 'converted', 'closed'] }).notNull().default('open'), ticketId: uuid('ticket_id'), createdAt: createdAt(), updatedAt: updatedAt(),
}, t => [unique('conversations_tenant_id_id').on(t.tenantId, t.id), foreignKey({ columns: [t.tenantId, t.customerId], foreignColumns: [users.tenantId, users.id] })]);
export const tickets = pgTable('tickets', {
  id: id(), tenantId: tenantId(), customerId: uuid('customer_id').notNull(), title: text('title').notNull(), body: text('body').notNull(), category: text('category'), urgency: text('urgency'), sentiment: text('sentiment'), idempotencyKey: text('idempotency_key'), autoAnsweredAt: time('auto_answered_at'), resolvedByCustomer: boolean('resolved_by_customer').notNull().default(false), closedAt: time('closed_at'),
  status: text('status', { enum: ['open', 'in_progress', 'resolved', 'closed'] }).notNull().default('open'), version: integer('version').notNull().default(1), autoReplyCount: integer('auto_reply_count').notNull().default(0),
  escalatedAt: time('escalated_at'), escalationReason: text('escalation_reason'), assigneeId: uuid('assignee_id'), conversationId: uuid('conversation_id').unique(), resolvedAt: time('resolved_at'), customerConfirmedAt: time('customer_confirmed_at'), createdAt: createdAt(), updatedAt: updatedAt(),
}, t => [unique('tickets_tenant_id_id').on(t.tenantId, t.id), foreignKey({ columns: [t.tenantId, t.customerId], foreignColumns: [users.tenantId, users.id] }), foreignKey({ columns: [t.tenantId, t.assigneeId], foreignColumns: [users.tenantId, users.id] }), foreignKey({ columns: [t.tenantId, t.conversationId], foreignColumns: [conversations.tenantId, conversations.id] }), check('ticket_status', sql`${t.status} in ('open','in_progress','resolved','closed')`), check('ticket_counts', sql`${t.version} > 0 and ${t.autoReplyCount} between 0 and 1`), index('tickets_customer').on(t.tenantId, t.customerId, t.createdAt)]);
export const aiJobs = pgTable('ai_jobs', {
  id: id(), tenantId: tenantId(), ticketId: uuid('ticket_id'), conversationId: uuid('conversation_id'), messageId: uuid('message_id'), kind: text('kind', { enum: ['process_inquiry', 'regenerate_draft'] }).notNull().default('process_inquiry'), pipelineVersion: text('pipeline_version').notNull().default('v1'), idempotencyKey: text('idempotency_key').notNull(),
  status: text('status', { enum: ['queued', 'processing', 'succeeded', 'failed'] }).notNull().default('queued'), attempts: integer('attempts').notNull().default(0), maxAttempts: integer('max_attempts').notNull().default(3), availableAt: time('available_at').notNull().defaultNow(), leaseUntil: time('lease_until'), leaseToken: uuid('lease_token'), lastError: text('last_error'), createdAt: createdAt(), updatedAt: updatedAt(),
}, t => [unique('ai_jobs_tenant_id_id').on(t.tenantId, t.id), unique('ai_jobs_idempotency').on(t.tenantId, t.idempotencyKey), foreignKey({ columns: [t.tenantId, t.ticketId], foreignColumns: [tickets.tenantId, tickets.id] }), foreignKey({ columns: [t.tenantId, t.conversationId], foreignColumns: [conversations.tenantId, conversations.id] }), check('ai_jobs_target', sql`(${t.ticketId} is not null)::int + (${t.conversationId} is not null)::int = 1`), check('ai_jobs_status', sql`${t.status} in ('queued','processing','succeeded','failed')`), check('ai_jobs_attempts', sql`${t.attempts} >= 0 and ${t.maxAttempts} > 0`), check('ai_jobs_process_message', sql`${t.kind} <> 'process_inquiry' or ${t.messageId} is not null`), index('ai_jobs_claim').on(t.status, t.availableAt, t.leaseUntil)]);
export const ticketMessages = pgTable('ticket_messages', {
  id: id(), tenantId: tenantId(), ticketId: uuid('ticket_id').notNull(), authorId: uuid('author_id'), role: text('role', { enum: ['customer', 'agent', 'tenant_admin', 'ai'] }).notNull(), authorType: text('author_type', { enum: ['customer', 'agent', 'ai', 'system'] }), sources: jsonb('sources').$type<PublicSource[]>(), draftId: uuid('draft_id'), body: text('body').notNull(), visibility: text('visibility', { enum: ['public', 'internal'] }).notNull().default('public'), createdAt: createdAt(), sourceJobId: uuid('source_job_id').unique(),
}, t => [unique('ticket_messages_tenant_id_id').on(t.tenantId, t.id), foreignKey({ columns: [t.tenantId, t.ticketId], foreignColumns: [tickets.tenantId, tickets.id] }), foreignKey({ columns: [t.tenantId, t.authorId], foreignColumns: [users.tenantId, users.id] }), foreignKey({ columns: [t.tenantId, t.sourceJobId], foreignColumns: [aiJobs.tenantId, aiJobs.id] }), check('ticket_message_role', sql`${t.role} in ('customer','agent','tenant_admin','ai')`), check('message_visibility', sql`${t.visibility} in ('public','internal')`)]);
export const conversationMessages = pgTable('conversation_messages', {
  id: id(), tenantId: tenantId(), conversationId: uuid('conversation_id').notNull(), role: text('role', { enum: ['user', 'assistant', 'system'] }).notNull(), sources: jsonb('sources').$type<PublicSource[]>(), reason: text('reason'), noticeCode: text('notice_code', { enum: ['APPROVAL_REQUIRED', 'ESCALATED', 'PROCESSING_FAILED'] }), body: text('body').notNull(), createdAt: createdAt(), sourceJobId: uuid('source_job_id').unique(),
}, t => [unique('conversation_messages_tenant_id_id').on(t.tenantId, t.id), foreignKey({ columns: [t.tenantId, t.conversationId], foreignColumns: [conversations.tenantId, conversations.id] }), foreignKey({ columns: [t.tenantId, t.sourceJobId], foreignColumns: [aiJobs.tenantId, aiJobs.id] }), check('conversation_message_role', sql`${t.role} in ('user','assistant','system')`)]);
export const aiRuns = pgTable('ai_runs', {
  id: id(), tenantId: tenantId(), ticketId: uuid('ticket_id'), conversationId: uuid('conversation_id'), jobId: uuid('job_id').unique(), messageId: uuid('message_id'), decision: text('decision'), reason: text('reason'), category: text('category'), urgency: text('urgency'), sentiment: text('sentiment'), confidence: doublePrecision('confidence'), sources: jsonb('sources').$type<Source[]>(), model: text('model'), inputTokens: integer('input_tokens'), outputTokens: integer('output_tokens'), latencyMs: integer('latency_ms'), error: text('error'), pipelineVersion: text('pipeline_version').notNull().default('v1'), status: text('status', { enum: ['queued', 'processing', 'succeeded', 'failed'] }).notNull().default('queued'), result: jsonb('result').$type<Record<string, unknown>>(), createdAt: createdAt(), updatedAt: updatedAt(),
}, t => [unique('ai_runs_tenant_id_id').on(t.tenantId, t.id), uniqueIndex('ai_runs_sse_conversation_message').on(t.tenantId, t.conversationId, t.messageId, t.pipelineVersion).where(sql`${t.jobId} is null and ${t.conversationId} is not null`), uniqueIndex('ai_runs_sse_ticket_message').on(t.tenantId, t.ticketId, t.messageId, t.pipelineVersion).where(sql`${t.jobId} is null and ${t.ticketId} is not null`), check('ai_runs_sse_message', sql`${t.jobId} is not null or ${t.messageId} is not null`), foreignKey({ columns: [t.tenantId, t.jobId], foreignColumns: [aiJobs.tenantId, aiJobs.id] }), foreignKey({ columns: [t.tenantId, t.ticketId], foreignColumns: [tickets.tenantId, tickets.id] }), foreignKey({ columns: [t.tenantId, t.conversationId], foreignColumns: [conversations.tenantId, conversations.id] }), check('ai_runs_source', sql`(${t.jobId} is not null)::int + (${t.conversationId} is not null)::int = 1`), check('ai_runs_worker_ticket', sql`${t.jobId} is null or ${t.ticketId} is not null`), check('ai_run_status', sql`${t.status} in ('queued','processing','succeeded','failed')`)]);
export const aiDrafts = pgTable('ai_drafts', {
  id: id(), tenantId: tenantId(), ticketId: uuid('ticket_id'), conversationId: uuid('conversation_id'), jobId: uuid('job_id').unique(), runId: uuid('run_id'), sources: jsonb('sources').$type<Source[]>(), decidedBy: uuid('decided_by'), decidedAt: time('decided_at'), rejectReason: text('reject_reason'), sentMessageId: uuid('sent_message_id'), body: text('body').notNull(), status: text('status', { enum: ['draft', 'approved', 'sent', 'rejected'] }).notNull().default('draft'), version: integer('version').notNull().default(1), createdAt: createdAt(), updatedAt: updatedAt(),
}, t => [unique('ai_drafts_tenant_id_id').on(t.tenantId, t.id), unique('ai_drafts_conversation_unique').on(t.conversationId), foreignKey({ columns: [t.tenantId, t.runId], foreignColumns: [aiRuns.tenantId, aiRuns.id] }), foreignKey({ columns: [t.tenantId, t.conversationId], foreignColumns: [conversations.tenantId, conversations.id] }), check('ai_drafts_source', sql`(${t.jobId} is not null)::int + (${t.conversationId} is not null)::int = 1`), check('ai_drafts_run_or_job', sql`${t.jobId} is not null or ${t.runId} is not null`), foreignKey({ columns: [t.tenantId, t.ticketId], foreignColumns: [tickets.tenantId, tickets.id] }), foreignKey({ columns: [t.tenantId, t.jobId], foreignColumns: [aiJobs.tenantId, aiJobs.id] }), check('ai_draft_status', sql`${t.status} in ('draft','approved','sent','rejected')`), check('ai_draft_version', sql`${t.version} > 0`)]);
export const kbArticles = pgTable('kb_articles', {
  id: id(), tenantId: tenantId(), slug: text('slug').notNull(), title: text('title').notNull(), question: text('question').notNull().default(''), body: text('body').notNull(), revision: integer('revision').notNull().default(1), category: text('category'), tags: jsonb('tags').$type<string[]>().notNull().default([]), published: boolean('published').notNull().default(true), sourceUrl: text('source_url'), createdAt: createdAt(), updatedAt: updatedAt(),
}, t => [unique('kb_tenant_slug').on(t.tenantId, t.slug), index('kb_tenant_category').on(t.tenantId, t.category)]);
export const auditLog = pgTable('audit_log', {
  id: id(), tenantId: uuid('tenant_id').references(() => tenants.id), actorId: uuid('actor_id').references(() => users.id), action: text('action').notNull(), targetType: text('target_type').notNull(), targetId: text('target_id'), meta: jsonb('meta').$type<Record<string, unknown>>().default({}), createdAt: createdAt(),
}, t => [index('audit_tenant_created').on(t.tenantId, t.createdAt)]);

export type Tenant = typeof tenants.$inferSelect;
export type NewTenant = typeof tenants.$inferInsert;
export type TenantSettings = typeof tenantSettings.$inferSelect;
export type NewTenantSettings = typeof tenantSettings.$inferInsert;
export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;
export type Session = typeof sessions.$inferSelect;
export type NewSession = typeof sessions.$inferInsert;
export type LoginAttempt = typeof loginAttempts.$inferSelect;
export type NewLoginAttempt = typeof loginAttempts.$inferInsert;
export type Ticket = typeof tickets.$inferSelect;
export type NewTicket = typeof tickets.$inferInsert;
export type TicketMessage = typeof ticketMessages.$inferSelect;
export type NewTicketMessage = typeof ticketMessages.$inferInsert;
export type Conversation = typeof conversations.$inferSelect;
export type NewConversation = typeof conversations.$inferInsert;
export type ConversationMessage = typeof conversationMessages.$inferSelect;
export type NewConversationMessage = typeof conversationMessages.$inferInsert;
export type AiJob = typeof aiJobs.$inferSelect;
export type NewAiJob = typeof aiJobs.$inferInsert;
export type AiRun = typeof aiRuns.$inferSelect;
export type NewAiRun = typeof aiRuns.$inferInsert;
export type AiDraft = typeof aiDrafts.$inferSelect;
export type NewAiDraft = typeof aiDrafts.$inferInsert;
export type KbArticle = typeof kbArticles.$inferSelect;
export type NewKbArticle = typeof kbArticles.$inferInsert;
export type AuditEntry = typeof auditLog.$inferSelect;
export type NewAuditEntry = typeof auditLog.$inferInsert;
