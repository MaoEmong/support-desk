import { randomUUID } from 'node:crypto';
import { sql, type SQL } from 'drizzle-orm';
import { projectPublicSources } from './public-sources.js';
export { projectPublicSources, type PublicSource } from './public-sources.js';

/** Pass @support/db's Drizzle database or transaction; both expose execute. */
export interface Executor { execute(query: SQL): Promise<unknown> }
export interface Database extends Executor { transaction<T>(fn: (tx: Executor) => Promise<T>): Promise<T> }
export type Target = { ticketId: string; conversationId?: never } | { conversationId: string; ticketId?: never };
export type JobKind = 'process_inquiry' | 'regenerate_draft';
export type Inquiry = Target & { tenantId: string; messageId: string | null; kind?: JobKind; pipelineVersion?: string };
export type AIRunResult = {
  body: string; action: 'reply' | 'draft' | 'escalate';
  decision?: string | null; reason?: string | null; category?: string | null;
  urgency?: string | null; sentiment?: string | null; confidence?: number | null;
  sources?: unknown[] | null; model?: string | null; inputTokens?: number | null;
  outputTokens?: number | null; latencyMs?: number | null; error?: string | null;
  pipelineVersion?: string | null; messageId?: string | null;
  /** Complete, deeply masked provider result, retaining nested policy/timing data. */
  aiResult?: unknown;
  [key: string]: unknown;
};
export type ProcessInquiry = (input: Inquiry) => Promise<AIRunResult>;
export const stubProcessInquiry: ProcessInquiry = async () => ({ body: '', action: 'escalate', reason: 'processor_not_configured' });
export interface Job { id: string; tenant_id: string; ticket_id: string | null; conversation_id: string | null; message_id: string | null; kind: JobKind; pipeline_version: string; attempts: number; max_attempts: number; lease_token: string }
export class VersionConflict extends Error { readonly status = 409; constructor() { super('Draft changed or is no longer available'); } }
export class LeaseLost extends Error { constructor() { super('Job lease expired or was replaced'); } }
export class WorkerStopping extends Error { constructor() { super('Worker is stopping'); } }
export class ProcessorFailure extends Error {
  constructor(readonly code: string, readonly result?: Partial<AIRunResult>, readonly permanent = false) { super(code); }
}
function rows<T>(value: unknown): T[] { return (Array.isArray(value) ? value : (value as { rows?: T[] })?.rows ?? []) as T[]; }
async function query<T>(db: Executor, statement: SQL): Promise<T[]> { return rows<T>(await db.execute(statement)); }
function target(input: Inquiry) { if (!!input.ticketId === !!input.conversationId) throw new Error('Exactly one target required'); }

async function storeRun(tx: Executor, job: Job, status: 'succeeded' | 'failed', result: Partial<AIRunResult>, disposition?: string) {
  const [saved] = await query<{ id: string }>(tx, sql`insert into ai_runs(
    id,tenant_id,ticket_id,conversation_id,job_id,status,result,
    decision,reason,category,urgency,sentiment,confidence,sources,model,
    input_tokens,output_tokens,latency_ms,error,pipeline_version,message_id,created_at,updated_at)
    values(${randomUUID()},${job.tenant_id},${job.ticket_id},${job.conversation_id},${job.id},${status},
    ${JSON.stringify({ ...result, ...(disposition ? { disposition } : {}) })}::jsonb,
    ${result.decision ?? null},${result.reason ?? null},${result.category ?? null},${result.urgency ?? null},${result.sentiment ?? null},
    ${result.confidence ?? null},${result.sources == null ? null : JSON.stringify(result.sources)}::jsonb,${result.model ?? null},
    ${result.inputTokens ?? null},${result.outputTokens ?? null},${result.latencyMs ?? null},${result.error ?? null},
    ${job.pipeline_version ?? null},${job.message_id ?? null},now(),now())
    on conflict(job_id) do update set status=excluded.status,result=excluded.result,
    decision=excluded.decision,reason=excluded.reason,category=excluded.category,urgency=excluded.urgency,
    sentiment=excluded.sentiment,confidence=excluded.confidence,sources=excluded.sources,model=excluded.model,
    input_tokens=excluded.input_tokens,output_tokens=excluded.output_tokens,latency_ms=excluded.latency_ms,
    error=excluded.error,pipeline_version=excluded.pipeline_version,message_id=excluded.message_id,updated_at=now() returning id`);
  return saved.id;
}

/** Call within the transaction that inserts the customer message. */
export async function enqueueInquiry(tx: Executor, input: Inquiry & { idempotencyKey: string; pipelineVersion?: string; maxAttempts?: number }): Promise<string> {
  target(input);
  if (input.conversationId) throw new Error('Conversations are processed by SSE, not the worker');
  if (!input.messageId && input.kind !== 'regenerate_draft') throw new Error('messageId required for process_inquiry');
  if (input.kind === 'regenerate_draft' && !input.ticketId) throw new Error('Draft regeneration requires a ticket');
  const max = input.maxAttempts ?? 3;
  if (!Number.isInteger(max) || max < 1) throw new Error('maxAttempts must be positive');
  const [job] = await query<{ id: string }>(tx, sql`insert into ai_jobs (id,tenant_id,ticket_id,conversation_id,message_id,idempotency_key,pipeline_version,kind,status,attempts,max_attempts,available_at,created_at,updated_at)
    values (${randomUUID()},${input.tenantId},${input.ticketId ?? null},${input.conversationId ?? null},${input.messageId},${input.idempotencyKey},${input.pipelineVersion ?? 'v1'},${input.kind ?? 'process_inquiry'},'queued',0,${max},now(),now(),now())
    on conflict (tenant_id,idempotency_key) do update set idempotency_key=excluded.idempotency_key returning id`);
  return job.id;
}

export class InquiryQueue {
  constructor(private readonly db: Database, private readonly processInquiry: ProcessInquiry = stubProcessInquiry) {}

  async claim(leaseSeconds = 60): Promise<Job | undefined> {
    if (!Number.isFinite(leaseSeconds) || leaseSeconds <= 0) throw new Error('Invalid lease duration');
    return this.db.transaction(async tx => {
      // Recovery and exhaustion use the same failure path as explicit errors.
      const expired = await query<Job>(tx, sql`select * from ai_jobs where ticket_id is not null and status='processing' and lease_until<=now() order by lease_until for update skip locked limit 50`);
      for (const job of expired) await this.failLocked(tx, job, 'lease_expired');
      const [job] = await query<Job>(tx, sql`with candidate as (select id from ai_jobs where ticket_id is not null and status='queued' and available_at<=now() and attempts<max_attempts order by available_at,created_at for update skip locked limit 1)
        update ai_jobs j set status='processing',attempts=j.attempts+1,lease_token=${randomUUID()},lease_until=now()+${leaseSeconds}*interval '1 second',updated_at=now() from candidate c where j.id=c.id returning j.*`);
      return job;
    });
  }

  async heartbeat(job: Job, leaseSeconds = 60): Promise<void> {
    if (!Number.isFinite(leaseSeconds) || leaseSeconds <= 0) throw new Error('Invalid lease duration');
    const result = await query(this.db, sql`update ai_jobs set lease_until=now()+${leaseSeconds}*interval '1 second',updated_at=now() where id=${job.id} and tenant_id=${job.tenant_id} and status='processing' and lease_token=${job.lease_token} and lease_until>now() returning id`);
    if (!result.length) throw new LeaseLost();
  }

  private async lock(tx: Executor, job: Job): Promise<Job> {
    const [locked] = await query<Job>(tx, sql`select * from ai_jobs where id=${job.id} and tenant_id=${job.tenant_id} and status='processing' and lease_token=${job.lease_token} and lease_until>now() for update`);
    if (!locked) throw new LeaseLost();
    return locked;
  }

  private async failLocked(tx: Executor, job: Job, reason: string, result?: Partial<AIRunResult>, permanent = false): Promise<void> {
    const final = permanent || job.attempts >= job.max_attempts;
    await tx.execute(sql`update ai_jobs set status=${final ? 'failed' : 'queued'},last_error=${reason},lease_until=null,lease_token=null,available_at=now()+${Math.min(300, 2 ** job.attempts)}*interval '1 second',updated_at=now() where id=${job.id} and tenant_id=${job.tenant_id}`);
    if (final) {
      if (job.ticket_id) await tx.execute(sql`update tickets set escalated_at=now(),escalation_reason='ai_job_failed',version=version+1,updated_at=now() where id=${job.ticket_id} and tenant_id=${job.tenant_id} and conversation_id is null and status in ('open','in_progress')`);
      await storeRun(tx, job, 'failed', { ...result, reason: result?.reason ?? reason, error: result?.error ?? reason });
    }
  }

  async fail(job: Job, reason = 'processor_failed', result?: Partial<AIRunResult>, permanent = false): Promise<void> {
    await this.db.transaction(async tx => this.failLocked(tx, await this.lock(tx, job), reason, result, permanent));
  }

  /** Recheck immediately before invoking AI; completion also checks under lock. */
  async eligible(job: Job): Promise<boolean> {
    if (!job.ticket_id || job.conversation_id) return false;
    const [ticket] = await query<{ status: string; conversation_id: string | null }>(this.db, sql`select status,conversation_id from tickets where id=${job.ticket_id} and tenant_id=${job.tenant_id}`);
    return !!ticket && !ticket.conversation_id && !['resolved', 'closed'].includes(ticket.status);
  }

  async complete(job: Job, result: AIRunResult): Promise<void> {
    await this.db.transaction(async tx => {
      const current = await this.lock(tx, job);
      let disposition: string = result.action;
      if (current.ticket_id) {
        const [ticket] = await query<{ auto_reply_count: number; status: string; conversation_id: string | null; escalated_at: unknown; approval_mode: boolean; auto_answer_limit: number }>(tx, sql`select auto_reply_count,status,conversation_id,escalated_at,coalesce((select approval_mode from tenant_settings where tenant_id=tickets.tenant_id),true) as approval_mode,coalesce((select auto_answer_limit from tenant_settings where tenant_id=tickets.tenant_id),0) as auto_answer_limit from tickets where id=${current.ticket_id} and tenant_id=${current.tenant_id} for update`);
        if (!ticket) throw new Error('Ticket missing');
        const agentReplies = await query(tx, sql`select id from ticket_messages where tenant_id=${current.tenant_id} and ticket_id=${current.ticket_id} and visibility='public' and role in ('agent','tenant_admin') limit 1`);
        const allowed = current.kind !== 'regenerate_draft' && result.action === 'reply' && !!result.body.trim() && ticket.auto_reply_count < Math.min(1, ticket.auto_answer_limit) && !ticket.escalated_at && !ticket.approval_mode && !agentReplies.length && ticket.status === 'open';
        if (ticket.conversation_id || ['closed', 'resolved'].includes(ticket.status)) {
          disposition = 'suppressed';
        } else if (allowed) {
          await tx.execute(sql`insert into ticket_messages(id,tenant_id,ticket_id,role,author_type,body,sources,visibility,source_job_id,created_at) values(${randomUUID()},${current.tenant_id},${current.ticket_id},'ai','ai',${result.body},${JSON.stringify(projectPublicSources(result.sources))}::jsonb,'public',${current.id},now())`);
          await tx.execute(sql`update tickets set auto_reply_count=auto_reply_count+1,auto_answered_at=now(),version=version+1,updated_at=now() where id=${current.ticket_id} and tenant_id=${current.tenant_id}`);
        } else {
          disposition = 'draft';
          const reason = current.kind !== 'regenerate_draft' && ticket.auto_reply_count >= Math.min(1, ticket.auto_answer_limit) ? 'auto_answer_limit' : ticket.approval_mode ? 'approval_mode' : agentReplies.length ? 'staff_replied' : result.reason ?? 'ai_review_required';
          await tx.execute(sql`insert into ai_drafts(id,tenant_id,ticket_id,job_id,body,sources,status,version,created_at,updated_at) values(${randomUUID()},${current.tenant_id},${current.ticket_id},${current.id},${result.body},${JSON.stringify(result.sources ?? [])}::jsonb,'draft',1,now(),now())`);
          await tx.execute(sql`update tickets set escalated_at=now(),escalation_reason=${reason},version=version+1,updated_at=now() where id=${current.ticket_id} and tenant_id=${current.tenant_id}`);
        }
        if (disposition !== 'suppressed') {
          // Older, slow inference must not overwrite a newer completed classification.
          await tx.execute(sql`update tickets set category=coalesce(${result.category ?? null},category),
            urgency=coalesce(${result.urgency ?? null},urgency),sentiment=coalesce(${result.sentiment ?? null},sentiment)
            where id=${current.ticket_id} and tenant_id=${current.tenant_id}
            and not exists(select 1 from ai_jobs newer where newer.ticket_id=${current.ticket_id}
              and newer.tenant_id=${current.tenant_id} and newer.status='succeeded'
              and newer.created_at>(select created_at from ai_jobs where id=${current.id}))`);
        }
      } else disposition = 'suppressed';
      const runId = await storeRun(tx, current, 'succeeded', result, disposition);
      if (disposition === 'draft') await tx.execute(sql`update ai_drafts set run_id=${runId} where job_id=${current.id} and tenant_id=${current.tenant_id}`);
      await tx.execute(sql`update ai_jobs set status='succeeded',lease_until=null,lease_token=null,updated_at=now() where id=${current.id} and tenant_id=${current.tenant_id}`);
    });
  }

  async runOnce(options: { signal?: AbortSignal; leaseSeconds?: number } = {}): Promise<boolean> {
    if (options.signal?.aborted) throw new WorkerStopping();
    const leaseSeconds = options.leaseSeconds ?? 60;
    const job = await this.claim(leaseSeconds);
    if (!job) return false;
    if (options.signal?.aborted) throw new WorkerStopping();
    if (!await this.eligible(job)) { await this.complete(job, { action: 'escalate', body: '', reason: 'ineligible_target' }); return true; }
    let rejectInterruption!: (error: Error) => void;
    const interruption = new Promise<never>((_, reject) => { rejectInterruption = reject; });
    const abort = () => rejectInterruption(new WorkerStopping());
    options.signal?.addEventListener('abort', abort, { once: true });
    let renewing = false;
    const timer = setInterval(() => {
      if (renewing) return;
      renewing = true;
      void this.heartbeat(job, leaseSeconds).catch(() => rejectInterruption(new LeaseLost())).finally(() => { renewing = false; });
    }, Math.max(100, leaseSeconds * 1000 / 3));
    try {
      if (options.signal?.aborted) throw new WorkerStopping();
      let result: AIRunResult;
      try {
        result = await Promise.race([this.processInquiry({ tenantId: job.tenant_id, messageId: job.message_id, kind: job.kind, pipelineVersion: job.pipeline_version, ticketId: job.ticket_id! }), interruption]);
      } catch (error) {
        if (error instanceof WorkerStopping || error instanceof LeaseLost) throw error;
        const failure = error instanceof ProcessorFailure ? error : new ProcessorFailure('processor_failed');
        await this.fail(job, failure.code, failure.result, failure.permanent);
        return true;
      }
      if (options.signal?.aborted) throw new WorkerStopping();
      await this.complete(job, result);
      return true;
    } finally {
      clearInterval(timer);
      options.signal?.removeEventListener('abort', abort);
    }
  }
}

/** Caller must authorize the agent and tenant before calling. All public agent
 * reply paths must lock the same ticket row before inserting a reply. */
export async function approveDraft(db: Database, input: { tenantId: string; ticketId: string; draftId: string; version: number; authorId: string }): Promise<string> {
  return db.transaction(async tx => {
    const tickets = await query(tx, sql`select id from tickets where id=${input.ticketId} and tenant_id=${input.tenantId} for update`);
    if (!tickets.length) throw new VersionConflict();
    const [draft] = await query<{ body: string; job_id: string; sources: unknown }>(tx, sql`select body,job_id,sources from ai_drafts where id=${input.draftId} and tenant_id=${input.tenantId} and ticket_id=${input.ticketId} and version=${input.version} and status in ('draft','approved') for update`);
    if (!draft) throw new VersionConflict();
    const id = randomUUID();
    await tx.execute(sql`insert into ticket_messages(id,tenant_id,ticket_id,author_id,role,author_type,body,sources,draft_id,visibility,source_job_id,created_at) values(${id},${input.tenantId},${input.ticketId},${input.authorId},'agent','agent',${draft.body},${JSON.stringify(projectPublicSources(draft.sources))}::jsonb,${input.draftId},'public',${draft.job_id},now())`);
    const sent = await query(tx, sql`update ai_drafts set status='sent',version=version+1,decided_by=${input.authorId},decided_at=now(),sent_message_id=${id},updated_at=now() where id=${input.draftId} and tenant_id=${input.tenantId} and ticket_id=${input.ticketId} and version=${input.version} and status in ('draft','approved') returning id`);
    if (!sent.length) throw new VersionConflict();
    await tx.execute(sql`update tickets set version=version+1,updated_at=now() where id=${input.ticketId} and tenant_id=${input.tenantId}`);
    return id;
  });
}




