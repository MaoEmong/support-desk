import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'vitest';
import postgres from 'postgres';
import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import { InquiryQueue, enqueueInquiry, approveDraft, LeaseLost, WorkerStopping, ProcessorFailure, VersionConflict, stubProcessInquiry, type AIRunResult, type ProcessInquiry } from '../src/index.js';

const injectedFAQ: ProcessInquiry = async () => ({
  body: 'FAQ 안내', action: 'reply', decision: 'auto_answer', reason: 'confident_kb_match', confidence: 0.9,
  aiResult: { decision: 'auto_answer', confidence: { final: 0.9 } },
});

const url = process.env.QUEUE_DATABASE_URL;
async function check(name: string, run: () => Promise<void>) {
  try { await run(); } catch (cause) { throw new Error(name, { cause }); }
}
test('unconfigured processor fails closed to agent review', async () => {
  const result = await stubProcessInquiry({ tenantId: randomUUID(), ticketId: randomUUID(), messageId: randomUUID() });
  assert.equal(result.action, 'escalate');
  assert.equal(result.body, '');
});
test('PostgreSQL durable queue invariants', { skip: !url, timeout: 30000 }, async () => {
  const schema = `queue_test_${randomUUID().replaceAll('-', '')}`;
  const admin = postgres(url!, { max: 1 });
  await admin.unsafe(`create schema "${schema}"`);
  const client = postgres(url!, { max: 6, connection: { search_path: schema } });
  const db = drizzle(client);
  const queue = new InquiryQueue(db);
  const tenant = randomUUID();
  try {
    await client.unsafe(`
      create table tenant_settings(tenant_id uuid primary key,approval_mode boolean not null default false,auto_answer_limit int not null default 1);
      create table tickets(id uuid primary key,tenant_id uuid not null,conversation_id uuid,status text not null default 'open',version int not null default 1,auto_reply_count int not null default 0,auto_answered_at timestamptz,category text,urgency text,sentiment text,escalated_at timestamptz,escalation_reason text,updated_at timestamptz default now());
      create table ai_jobs(id uuid primary key,tenant_id uuid not null,ticket_id uuid,conversation_id uuid,message_id uuid,kind text not null default 'process_inquiry',idempotency_key text not null,pipeline_version text not null default 'v1',status text not null check(status in ('queued','processing','succeeded','failed')),attempts int not null default 0,max_attempts int not null default 3,available_at timestamptz not null,lease_until timestamptz,lease_token uuid,last_error text,created_at timestamptz not null,updated_at timestamptz not null,unique(tenant_id,idempotency_key),check((ticket_id is null) <> (conversation_id is null)));
      create table ticket_messages(id uuid primary key,tenant_id uuid not null,ticket_id uuid not null,author_id uuid,role text not null,author_type text not null default 'system',body text not null,sources jsonb,draft_id uuid,visibility text not null,source_job_id uuid unique,created_at timestamptz not null);
      create table conversation_messages(id uuid primary key,tenant_id uuid not null,conversation_id uuid not null,role text not null check(role in ('user','assistant','system')),body text not null,source_job_id uuid unique,created_at timestamptz not null);
      create table ai_runs(id uuid primary key,tenant_id uuid not null,ticket_id uuid,conversation_id uuid,job_id uuid not null unique,status text not null,result jsonb not null,decision text,reason text,category text,urgency text,sentiment text,confidence double precision,sources jsonb,model text,input_tokens int,output_tokens int,latency_ms int,error text,pipeline_version text,message_id uuid,created_at timestamptz not null,updated_at timestamptz not null);
      create table ai_drafts(id uuid primary key,tenant_id uuid not null,ticket_id uuid not null,job_id uuid not null unique,run_id uuid,sources jsonb,decided_by uuid,decided_at timestamptz,sent_message_id uuid,body text not null,status text not null,version int not null default 1,created_at timestamptz not null,updated_at timestamptz not null);
    `);
    await client`insert into tenant_settings(tenant_id,approval_mode) values(${tenant},false)`;
    async function seed(maxAttempts = 3) {
      const ticketId = randomUUID();
      await client`insert into tickets(id,tenant_id) values(${ticketId},${tenant})`;
      const input = { tenantId: tenant, ticketId, messageId: randomUUID(), idempotencyKey: randomUUID(), maxAttempts };
      const id = await db.transaction(tx => enqueueInquiry(tx, input));
      return { ticketId, input, id };
    }
    await check('enqueue idempotency and caller transaction rollback', async () => {
      const { id, input } = await seed();
      assert.equal(await db.transaction(tx => enqueueInquiry(tx, input)), id);
      const key = randomUUID();
      await assert.rejects(db.transaction(async tx => { await enqueueInquiry(tx, { ...input, idempotencyKey: key }); throw new Error('rollback'); }));
      assert.equal((await client`select id from ai_jobs where idempotency_key=${key}`).length, 0);
      await client`delete from ai_jobs`;
    });
    await check('concurrent SKIP LOCKED claims each job once', async () => {
      await seed(); await seed();
      const claims = await Promise.all([queue.claim(), queue.claim(), queue.claim()]);
      assert.equal(claims.filter(Boolean).length, 2);
      assert.equal(new Set(claims.filter(Boolean).map(j => j!.id)).size, 2);
      await client`delete from ai_jobs`;
    });
    await check('expired lease recovery fences stale worker', async () => {
      await seed();
      const old = (await queue.claim())!;
      await client`update ai_jobs set lease_until=now()-interval '1 second' where id=${old.id}`;
      assert.equal(await queue.claim(), undefined);
      await client`update ai_jobs set available_at=now() where id=${old.id}`;
      const fresh = (await queue.claim())!;
      assert.notEqual(old.lease_token, fresh.lease_token);
      await assert.rejects(queue.complete(old, { action: 'reply', body: 'stale' }), LeaseLost);
      await assert.rejects(queue.fail(old), LeaseLost);
      await queue.complete(fresh, { action: 'reply', body: 'fresh' });
      assert.equal((await client`select body from ticket_messages where source_job_id=${old.id}`)[0].body, 'fresh');
    });
    await check('final failure escalates ticket and persists run atomically', async () => {
      const { ticketId } = await seed(1);
      const job = (await queue.claim())!;
      await queue.fail(job);
      assert.equal((await client`select status from ai_jobs where id=${job.id}`)[0].status, 'failed');
      assert.equal((await client`select status from tickets where id=${ticketId}`)[0].status, 'open');
      const [escalation] = await client`select escalated_at,escalation_reason from tickets where id=${ticketId}`;
      assert.ok(escalation.escalated_at);
      assert.equal(escalation.escalation_reason, 'ai_job_failed');
      assert.equal((await client`select status from ai_runs where job_id=${job.id}`)[0].status, 'failed');
    });
    await check('heartbeat extends only a current live lease and never revives expired ownership', async () => {
      await seed();
      const job = (await queue.claim(10))!;
      const [before] = await client`select lease_until from ai_jobs where id=${job.id}`;
      await queue.heartbeat(job, 60);
      const [after] = await client`select lease_until from ai_jobs where id=${job.id}`;
      assert.ok(new Date(after.lease_until).getTime() > new Date(before.lease_until).getTime());
      await assert.rejects(queue.heartbeat({ ...job, lease_token: randomUUID() }), LeaseLost);
      await client`update ai_jobs set lease_until=now()-interval '1 second' where id=${job.id}`;
      await assert.rejects(queue.heartbeat(job), LeaseLost);
      await queue.claim();
      await client`update ai_jobs set available_at=now() where id=${job.id}`;
      const recovered = (await queue.claim())!;
      await queue.complete(recovered, { action: 'draft', body: 'recovered' });
    });
    await check('second automatic reply becomes draft', async () => {
      const { input, ticketId } = await seed();
      await queue.complete((await queue.claim())!, { action: 'reply', body: 'first' });
      await db.transaction(tx => enqueueInquiry(tx, { ...input, messageId: randomUUID(), idempotencyKey: randomUUID() }));
      const second = (await queue.claim())!;
      await queue.complete(second, { action: 'reply', body: 'second' });
      assert.equal((await client`select count(*)::int as n from ticket_messages where ticket_id=${ticketId}`)[0].n, 1);
      assert.equal((await client`select body from ai_drafts where job_id=${second.id}`)[0].body, 'second');
    });
    await check('nullable-message draft regeneration never publishes automatically', async () => {
      const ticketId = randomUUID();
      await client`insert into tickets(id,tenant_id) values(${ticketId},${tenant})`;
      await db.transaction(tx => enqueueInquiry(tx, {
        tenantId: tenant, ticketId, messageId: null, kind: 'regenerate_draft', idempotencyKey: randomUUID(),
      }));
      const worker = new InquiryQueue(db, async input => {
        assert.equal(input.kind, 'regenerate_draft');
        assert.equal(input.messageId, null);
        return { action: 'reply', body: 'regenerated draft' };
      });
      await worker.runOnce();
      assert.equal((await client`select id from ticket_messages where ticket_id=${ticketId}`).length, 0);
      assert.equal((await client`select body from ai_drafts where ticket_id=${ticketId}`)[0].body, 'regenerated draft');
    });
    await check('AI analysis maps to individual run columns and active ticket classification', async () => {
      const { ticketId, input } = await seed();
      const job = (await queue.claim())!;
      const result = {
        action: 'draft' as const, body: 'review', decision: 'escalate', reason: 'policy',
        category: 'billing', urgency: 'high', sentiment: 'negative', confidence: 0.91,
        sources: [{ id: 'kb-1' }], model: 'mock', inputTokens: 0, outputTokens: 14,
        latencyMs: 24, error: 'diagnostic', pipelineVersion: 'untrusted-provider-version', messageId: randomUUID(),
        tenantId: randomUUID(), ticketId: randomUUID(), conversationId: randomUUID(),
      };
      await queue.complete(job, result);
      const [run] = await client`select * from ai_runs where job_id=${job.id}`;
      for (const name of ['decision', 'reason', 'category', 'urgency', 'sentiment', 'confidence', 'model', 'error'] as const) {
        assert.equal(run[name], result[name]);
      }
      assert.deepEqual(run.sources, result.sources);
      assert.equal(run.input_tokens, 0);
      assert.equal(run.output_tokens, 14);
      assert.equal(run.latency_ms, 24);
      assert.equal(run.pipeline_version, job.pipeline_version);
      assert.equal(run.message_id, input.messageId);
      assert.equal(run.tenant_id, tenant);
      assert.equal(run.ticket_id, ticketId);
      assert.equal(run.conversation_id, null);
      assert.deepEqual(run.result, { ...result, disposition: 'draft' });
      const [ticket] = await client`select category,urgency,sentiment from tickets where id=${ticketId}`;
      assert.deepEqual({ ...ticket }, { category: 'billing', urgency: 'high', sentiment: 'negative' });
    });
    await check('older completion cannot overwrite newer classification; missing analytics stay null', async () => {
      const { ticketId, input } = await seed();
      const old = (await queue.claim())!;
      const freshId = await db.transaction(tx => enqueueInquiry(tx, { ...input, idempotencyKey: randomUUID(), messageId: randomUUID() }));
      await client`update ai_jobs set created_at=(select created_at+interval '1 second' from ai_jobs where id=${old.id}) where id=${freshId}`;
      const fresh = (await queue.claim())!;
      await queue.complete(fresh, { action: 'draft', body: 'new', category: 'latest', urgency: 'high' });
      await queue.complete(old, { action: 'draft', body: 'old', category: 'outdated', sentiment: 'negative' });
      const [ticket] = await client`select category,urgency,sentiment from tickets where id=${ticketId}`;
      assert.equal(ticket.category, 'latest');
      assert.equal(ticket.urgency, 'high');
      assert.equal(ticket.sentiment, null);
      const [run] = await client`select * from ai_runs where job_id=${fresh.id}`;
      for (const column of ['decision','reason','sentiment','confidence','sources','model','input_tokens','output_tokens','latency_ms','error']) assert.equal(run[column], null);
      assert.equal(run.message_id, fresh.message_id);
      assert.equal(run.pipeline_version, fresh.pipeline_version);
    });
    await check('approval mode overrides provider automatic reply', async () => {
      await client`insert into tenant_settings(tenant_id,approval_mode) values(${tenant},true) on conflict(tenant_id) do update set approval_mode=true`;
      await seed();
      const job = (await queue.claim())!;
      await queue.complete(job, { action: 'reply', body: 'requires approval' });
      assert.equal((await client`select id from ticket_messages where source_job_id=${job.id}`).length, 0);
      assert.equal((await client`select status from ai_drafts where job_id=${job.id}`)[0].status, 'draft');
      await client`update tenant_settings set approval_mode=false`;
    });
    await check('old jobs cannot publicly reply to resolved or closed tickets', async () => {
      for (const status of ['resolved', 'closed']) {
        const { ticketId } = await seed();
        const job = (await queue.claim())!;
        await client`update tickets set status=${status},category='original',urgency='low',sentiment='neutral' where id=${ticketId}`;
        const [before] = await client`select * from tickets where id=${ticketId}`;
        await queue.complete(job, { action: 'reply', body: 'old automatic reply', category: 'changed', urgency: 'high', sentiment: 'negative' });
        assert.equal((await client`select id from ticket_messages where source_job_id=${job.id}`).length, 0);
        assert.equal((await client`select status from tickets where id=${ticketId}`)[0].status, status);
        assert.equal((await client`select id from ai_drafts where job_id=${job.id}`).length, 0);
        assert.equal((await client`select result from ai_runs where job_id=${job.id}`)[0].result.disposition, 'suppressed');
        const [after] = await client`select * from tickets where id=${ticketId}`;
        assert.deepEqual({ ...after }, { ...before });
      }
    });
    await check('human reply suppresses late AI; approval version conflicts; insert failure rolls back', async () => {
      const { ticketId } = await seed();
      const job = (await queue.claim())!;
      await client`insert into ticket_messages(id,tenant_id,ticket_id,role,body,visibility,created_at) values(${randomUUID()},${tenant},${ticketId},'agent','human','public',now())`;
      await queue.complete(job, { action: 'reply', body: 'late AI' });
      assert.equal((await client`select id from ticket_messages where source_job_id=${job.id}`).length, 0);
      const [draft] = await client`select id from ai_drafts where job_id=${job.id}`;
      const args = { tenantId: tenant, ticketId, draftId: draft.id as string, version: 1, authorId: randomUUID() };
      await assert.rejects(approveDraft(db, { ...args, tenantId: randomUUID() }), VersionConflict);
      await assert.rejects(approveDraft(db, { ...args, version: 2 }), VersionConflict);
      // Force message insertion failure; conditional draft update must not commit.
      await client`insert into ticket_messages(id,tenant_id,ticket_id,role,body,visibility,source_job_id,created_at) values(${randomUUID()},${tenant},${ticketId},'agent','collision','public',${job.id},now())`;
      await assert.rejects(approveDraft(db, args));
      assert.equal((await client`select status from ai_drafts where id=${draft.id}`)[0].status, 'draft');
      await client`delete from ticket_messages where source_job_id=${job.id}`;
      const results = await Promise.allSettled([approveDraft(db, args), approveDraft(db, args)]);
      assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
      assert.ok(results.some(r => r.status === 'rejected' && r.reason instanceof VersionConflict));
      assert.equal((await client`select count(*)::int as n from ticket_messages where source_job_id=${job.id}`)[0].n, 1);
    });
    await check('worker excludes SSE conversations and converted tickets', async () => {
      const conversationId = randomUUID();
      await assert.rejects(db.transaction(tx => enqueueInquiry(tx, { tenantId: tenant, conversationId, messageId: randomUUID(), idempotencyKey: randomUUID() })));
      const { ticketId } = await seed();
      await client`update tickets set conversation_id=${conversationId} where id=${ticketId}`;
      let calls = 0;
      const worker = new InquiryQueue(db, async () => { calls++; return { action: 'reply', body: 'forbidden' }; });
      assert.equal(await worker.runOnce(), true);
      assert.equal(calls, 0);
      assert.equal((await client`select id from ticket_messages where ticket_id=${ticketId}`).length, 0);
      assert.equal((await client`select id from ai_drafts where ticket_id=${ticketId}`).length, 0);
    });
    await check('DI processor plus PostgreSQL: FAQ once, follow-up escalates, no duplicates', async () => {
      const { ticketId, input } = await seed();
      const worker = new InquiryQueue(db, injectedFAQ);
      await worker.runOnce();
      await db.transaction(tx => enqueueInquiry(tx, { ...input, idempotencyKey: randomUUID(), messageId: randomUUID() }));
      await worker.runOnce();
      assert.equal(await worker.runOnce(), false);
      assert.equal((await client`select count(*)::int as n from ticket_messages where ticket_id=${ticketId} and role='ai'`)[0].n, 1);
      assert.equal((await client`select escalation_reason from tickets where id=${ticketId}`)[0].escalation_reason, 'auto_answer_limit');
      assert.equal((await client`select count(*)::int as n from ai_drafts where ticket_id=${ticketId} and status='draft'`)[0].n, 1);
      const [run] = await client`select * from ai_runs where ticket_id=${ticketId} order by created_at limit 1`;
      assert.equal(run.decision, 'auto_answer');
      assert.equal(run.result.aiResult.decision, 'auto_answer');
      assert.equal(run.confidence, run.result.aiResult.confidence.final);
    });
    await check('DI pending approval stays private; adapter rejection becomes final failure', async () => {
      await client`update tenant_settings set approval_mode=true`;
      const { ticketId } = await seed();
      await new InquiryQueue(db, async () => ({ body: 'Private draft', action: 'draft', decision: 'pending_approval', reason: 'approval_mode' })).runOnce();
      assert.equal((await client`select id from ticket_messages where ticket_id=${ticketId}`).length, 0);
      assert.equal((await client`select status from ai_drafts where ticket_id=${ticketId}`)[0].status, 'draft');
      assert.equal((await client`select decision from ai_runs where ticket_id=${ticketId}`)[0].decision, 'pending_approval');
      await client`update tenant_settings set approval_mode=false`;
      const foreign = await seed();
      await new InquiryQueue(db, async () => { throw new ProcessorFailure('tenant_source_mismatch', undefined, true); }).runOnce();
      assert.equal((await client`select status from ai_jobs where id=${foreign.id}`)[0].status, 'failed');
      assert.equal((await client`select id from ticket_messages where ticket_id=${foreign.ticketId}`).length, 0);
      assert.equal((await client`select id from ai_drafts where ticket_id=${foreign.ticketId}`).length, 0);
    });
    await check('shutdown fences in-flight output; restart recovers lease and sends only once', async () => {
      const { ticketId, id } = await seed();
      let started!: () => void;
      const ready = new Promise<void>(resolve => { started = resolve; });
      let finish!: (result: { action: 'reply'; body: string }) => void;
      const pending = new Promise<{ action: 'reply'; body: string }>(resolve => { finish = resolve; });
      const stop = new AbortController();
      const worker = new InquiryQueue(db, async () => { started(); return pending; });
      const active = worker.runOnce({ signal: stop.signal });
      await ready;
      stop.abort();
      await assert.rejects(active, WorkerStopping);
      assert.equal((await client`select status from ai_jobs where id=${id}`)[0].status, 'processing');
      await client`update ai_jobs set lease_until=now()-interval '1 second' where id=${id}`;
      const restarted = new InquiryQueue(db, injectedFAQ);
      assert.equal(await restarted.claim(), undefined);
      await client`update ai_jobs set available_at=now() where id=${id}`;
      await restarted.runOnce();
      finish({ action: 'reply', body: 'discarded old output' });
      assert.equal((await client`select count(*)::int as n from ticket_messages where ticket_id=${ticketId}`)[0].n, 1);
      assert.equal((await client`select attempts from ai_jobs where id=${id}`)[0].attempts, 2);
    });
    await check('provider errors retry within budget and preserve masked analysis on final failure', async () => {
      const { ticketId, id } = await seed(2);
      const adapted: AIRunResult = {
        body: '', action: 'escalate', decision: 'escalate', reason: 'ai_error', confidence: 0.4,
        error: 'masked provider error', aiResult: { error: { code: 'PROVIDER_ERROR', message: 'masked provider error' } },
      };
      const worker = new InquiryQueue(db, async () => { throw new ProcessorFailure('ai_provider_error', adapted); });
      await worker.runOnce();
      assert.equal((await client`select status from ai_jobs where id=${id}`)[0].status, 'queued');
      assert.equal((await client`select id from ai_runs where job_id=${id}`).length, 0);
      await client`update ai_jobs set available_at=now() where id=${id}`;
      await worker.runOnce();
      assert.equal((await client`select status from ai_jobs where id=${id}`)[0].status, 'failed');
      const [run] = await client`select * from ai_runs where job_id=${id}`;
      assert.equal(run.status, 'failed');
      assert.equal(run.decision, adapted.decision);
      assert.equal(run.confidence, adapted.confidence);
      assert.deepEqual(run.result.aiResult, adapted.aiResult);
      assert.equal((await client`select escalation_reason from tickets where id=${ticketId}`)[0].escalation_reason, 'ai_job_failed');
      assert.equal((await client`select id from ticket_messages where ticket_id=${ticketId}`).length, 0);
    });
    await check('CONFIG_ERROR adapter result is preserved on permanent failure without retry or publication', async () => {
      const { ticketId, input, id } = await seed(3);
      const maskedResult: AIRunResult = {
        action: 'draft', body: '', decision: 'escalate', reason: 'ai_error', error: 'CONFIG_ERROR', confidence: 0,
        aiResult: {
          decision: 'escalate', reason: 'ai_error',
          error: { code: 'CONFIG_ERROR', message: 'masked configuration failure' },
          confidence: { final: 0, llm: 0, retrieval: 0, rule: 0 }, draft: null,
        },
      };
      await new InquiryQueue(db, async () => { throw new ProcessorFailure('ai_config_error', maskedResult, true); }).runOnce();
      const [job] = await client`select status,attempts from ai_jobs where id=${id}`;
      assert.equal(job.status, 'failed');
      assert.equal(job.attempts, 1);
      const [run] = await client`select * from ai_runs where job_id=${id}`;
      assert.equal(run.error, 'CONFIG_ERROR');
      assert.equal(run.decision, 'escalate');
      assert.equal(run.reason, 'ai_error');
      assert.equal(run.confidence, 0);
      assert.equal(run.message_id, input.messageId);
      assert.equal(run.conversation_id, null);
      assert.deepEqual(run.result.aiResult, maskedResult.aiResult);
      assert.equal((await client`select id from ticket_messages where source_job_id=${id}`).length, 0);
      assert.equal((await client`select id from ai_drafts where job_id=${id}`).length, 0);
      assert.equal((await client`select escalation_reason from tickets where id=${ticketId}`)[0].escalation_reason, 'ai_job_failed');
    });
    await check('final ticket lock rechecks changes made during DI inference', async () => {
      for (const change of ['approval', 'limit', 'staff', 'closed', 'converted']) {
        await client`update tenant_settings set approval_mode=false,auto_answer_limit=1`;
        const { ticketId, input, id } = await seed();
        let notifyStarted!: () => void;
        const started = new Promise<void>(resolve => { notifyStarted = resolve; });
        let finish!: (result: AIRunResult) => void;
        const inference = new Promise<AIRunResult>(resolve => { finish = resolve; });
        const worker = new InquiryQueue(db, async inquiry => {
          assert.equal(inquiry.tenantId, tenant);
          assert.equal(inquiry.ticketId, ticketId);
          assert.equal(inquiry.messageId, input.messageId);
          notifyStarted();
          return inference;
        });
        const active = worker.runOnce();
        await started;
        if (change === 'approval') await client`update tenant_settings set approval_mode=true where tenant_id=${tenant}`;
        if (change === 'limit') await client`update tenant_settings set auto_answer_limit=0 where tenant_id=${tenant}`;
        if (change === 'staff') await db.transaction(async tx => {
          // Match the server's ticket-lock-before-public-reply contract.
          await tx.execute(sql`select id from tickets where id=${ticketId} and tenant_id=${tenant} for update`);
          await tx.execute(sql`insert into ticket_messages(id,tenant_id,ticket_id,role,author_type,body,visibility,created_at) values(${randomUUID()},${tenant},${ticketId},'agent','agent','staff reply','public',now())`);
        });
        if (change === 'closed') await client`update tickets set status='closed' where id=${ticketId}`;
        if (change === 'converted') await client`update tickets set conversation_id=${randomUUID()} where id=${ticketId}`;
        const rawAdapterJSON = { classification: { category: 'install' }, confidence: { final: 0.91, rule: 1 }, flags: { injectionSuspected: false }, future: ['retain', { nested: true }] };
        finish({ body: 'would auto-send', action: 'reply', decision: 'auto_answer', confidence: 0.91, aiResult: rawAdapterJSON });
        await active;
        assert.equal((await client`select id from ticket_messages where source_job_id=${id}`).length, 0);
        const [run] = await client`select * from ai_runs where job_id=${id}`;
        assert.deepEqual(run.result.aiResult, rawAdapterJSON);
        assert.equal(run.message_id, input.messageId);
        assert.equal(run.conversation_id, null); // job-origin run, even after conversion
        assert.equal(run.confidence, 0.91);
        if (change === 'closed' || change === 'converted') {
          assert.equal(run.result.disposition, 'suppressed');
          assert.equal((await client`select id from ai_drafts where job_id=${id}`).length, 0);
        } else {
          assert.equal((await client`select status from ai_drafts where job_id=${id}`)[0].status, 'draft');
          const expectedReason = change === 'approval' ? 'approval_mode' : change === 'limit' ? 'auto_answer_limit' : 'staff_replied';
          assert.equal((await client`select escalation_reason from tickets where id=${ticketId}`)[0].escalation_reason, expectedReason);
        }
      }
      await client`update tenant_settings set approval_mode=false,auto_answer_limit=1`;
    });
    await check('public auto and approved messages project sources while ai_runs keeps original analysis', async () => {
      const { ticketId, input, id } = await seed();
      const rawSources = [{
        kbArticleId: 'kb-faq', title: 'FAQ 안내', excerpt: '안내 요약', url: 'https://help.example/faq',
        tenantId: tenant, score: 0.97, raw: { searchTrace: 'internal-only' }, futureAnalysis: 'private',
      }];
      const expected = [{ id: 'kb-faq', title: 'FAQ 안내', excerpt: '안내 요약', url: 'https://help.example/faq' }];
      const processor: ProcessInquiry = async () => ({ body: 'FAQ answer', action: 'reply', sources: rawSources });
      const worker = new InquiryQueue(db, processor);
      await worker.runOnce();
      const [automatic] = await client`select sources from ticket_messages where source_job_id=${id}`;
      assert.deepEqual(automatic.sources, expected);
      const [run] = await client`select sources,result from ai_runs where job_id=${id}`;
      assert.deepEqual(run.sources, rawSources);
      assert.deepEqual(run.result.sources, rawSources);
      const secondId = await db.transaction(tx => enqueueInquiry(tx, { ...input, messageId: randomUUID(), idempotencyKey: randomUUID() }));
      await worker.runOnce();
      const [draft] = await client`select id,version,sources from ai_drafts where job_id=${secondId}`;
      assert.deepEqual(draft.sources, rawSources);
      const sentId = await approveDraft(db, { tenantId: tenant, ticketId, draftId: draft.id, version: draft.version, authorId: randomUUID() });
      const [approved] = await client`select sources from ticket_messages where id=${sentId}`;
      assert.deepEqual(approved.sources, expected);
      for (const source of [...automatic.sources, ...approved.sources]) {
        assert.deepEqual(Object.keys(source).sort(), ['excerpt', 'id', 'title', 'url']);
        for (const internalKey of ['kbArticleId', 'tenantId', 'score', 'raw', 'futureAnalysis']) assert.equal(internalKey in source, false);
      }
    });
    await check('missing sources persist as an empty public array on automatic and approved delivery', async () => {
      for (const action of ['reply', 'draft'] as const) {
        const { ticketId, id } = await seed();
        await new InquiryQueue(db, async () => ({ body: 'No references', action })).runOnce();
        if (action === 'draft') {
          const [draft] = await client`select id,version from ai_drafts where job_id=${id}`;
          await approveDraft(db, { tenantId: tenant, ticketId, draftId: draft.id, version: draft.version, authorId: randomUUID() });
        }
        const [message] = await client`select sources from ticket_messages where source_job_id=${id}`;
        assert.deepEqual(message.sources, []);
      }
    });
  } finally {
    await client.end();
    await admin.unsafe(`drop schema "${schema}" cascade`);
    await admin.end();
  }
});






