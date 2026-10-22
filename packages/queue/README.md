# @support/queue

Durable PostgreSQL ticket jobs through a Drizzle executor (including node-postgres). SQL accepts either execute-result arrays or `{ rows }`. Conversations belong to SSE: enqueue rejects them and the worker never claims existing conversation jobs. Converted, resolved and closed tickets skip AI invocation and public delivery.

## API integration

```ts
import { enqueueInquiry, approveDraft, VersionConflict } from '@support/queue';

await db.transaction(async tx => {
  // Authorize tenant/customer and insert their message with this same tx.
  await enqueueInquiry(tx, {
    tenantId, ticketId, messageId, pipelineVersion: 'ai-pipeline@1',
    idempotencyKey: `ticket:${ticketId}:message:${messageId}:ai-pipeline@1`,
  });
});

// Explicitly authorized regeneration: distinct immutable request key.
await db.transaction(tx => enqueueInquiry(tx, {
  tenantId, ticketId, messageId: null, kind: 'regenerate_draft',
  pipelineVersion: 'ai-pipeline@1', idempotencyKey: `regenerate:${requestId}`,
}));

try {
  await approveDraft(db, { tenantId, ticketId, draftId, version, authorId });
} catch (error) {
  if (error instanceof VersionConflict) { /* HTTP 409; reload draft */ }
  else throw error;
}
```

API callers own authorization. Staff public-reply paths must lock the same tenant-scoped ticket before insertion. Approval locks ticket/draft, inserts the message, then conditionally updates draft version/state in the same transaction. Any conflict or insertion error rolls back everything. Unique source_job_id prevents duplicate delivery. Database draft status is always `draft`; `pending_approval` is a pipeline decision.

Claim uses FOR UPDATE SKIP LOCKED, fresh lease tokens and bounded exponential retries. runOnce renews the lease during inference and checks ownership at completion. Final failures record a failed run and escalate active unconverted tickets while preserving status and assignee. Production injects the real processor; the default stub escalates.

The completion transaction locks the ticket and rechecks count (maximum one, also respecting the current tenant limit), approval mode, staff public replies, conversion and terminal status. Follow-ups become drafts with escalation_reason `auto_answer_limit`; approval uses `approval_mode`. Regeneration never publishes automatically. Terminal/converted completions preserve all ticket fields and record disposition `suppressed`, with no message/draft.

Public automatic and approved messages store only projected sources: `{ id, title, excerpt?, url? }`. `projectPublicSources` is exported for other public-message writers, including the server-owned SSE conversation path. It explicitly maps AI `kbArticleId` to public `id` (and accepts an already projected `id`), constructs fresh allowlisted objects and returns `[]` for absent sources. No tenantId, score, raw or future analysis fields are copied. ai_runs and private ai_drafts retain original masked source analysis separately.

Source ownership and URL domain/sanitization checks belong to the upstream server/AI boundary. Projection copies only an already sanitized url string, omits null optional values and never derives links from rawURL or analysis metadata.

## Injected AI adapter boundary

The API-owned `server/ai/queue-adapter.ts` calls real AI processInquiry, masks results and resolves regeneration message IDs. Queue imports neither AI nor web modules. Bootstrap injects only `{ db, processInquiry, close? }`. API owns published tenant KB loading, revision invalidation, settings and inquiry readers.

The injected adapter must validate result identity and both source arrays, then apply maskDeep before returning the queue AIRunResult. Its aiResult field can retain every nested provider field. Queue stores the complete returned JSON and individual decision/reason/classification/confidence/token/model/timing/error columns. Identity columns always use locked job context. Delivery disposition is separate from original provider decision. Active ticket classification updates only if no newer completed job supersedes it; missing fields preserve previous values.

Adapters can throw ProcessorFailure(code, maskedResult?, permanent?). Transient provider errors retry; permanent configuration/input/tenant failures fail closed. Regeneration message lookup belongs to the server adapter. Logs receive only generic codes. AI-dependent adapter/PG test drafts are preserved under handoff/*.ts.txt for the API team; they are not compiled or executed as queue code.

The real pipeline can return decision escalate/reason ai_error with error.code CONFIG_ERROR instead of throwing. The server adapter translates that result to ProcessorFailure('ai_config_error', maskedResult, true). Queue preserves both the full masked error graph and individual error/decision/reason/confidence columns on the first-attempt terminal failure, without publishing a message or creating an empty draft.

## Independent worker and bootstrap

Script `pnpm --filter @support/queue worker` runs `tsx src/worker-entry.ts`. Root concurrent startup belongs to foundation. WORKER_POLL_INTERVAL_MS defaults to 1000 (10–60000). AI_MODE defaults to mock only when not explicitly configured; Claude never silently falls back.

WORKER_BOOTSTRAP_MODULE is an absolute path or file URL to an API-owned Node-safe module:

```ts
export async function createWorkerDependencies() {
  return {
    db,                         // Drizzle Database
    processInquiry,             // Server-owned adapter, queue ProcessInquiry type
    close: async () => pool.end(),
  };
}
```

The bootstrap must avoid Next-only/server-only modules and worker startup side effects. Build the provider in the factory after environment loading. The executable loads the explicitly configured module; the queue library never imports the web server.

SIGTERM/SIGINT stops claims and lease renewal and discards in-flight output. Jobs retain their durable processing lease until a restarted worker recovers it. Later provider completion cannot commit discarded output. Both recovery and completion enforce fencing.

## Verification status

QUEUE_DATABASE_URL enables a disposable real PostgreSQL suite with isolated-schema cleanup. Queue tests use DI processors and cover concurrency, rollback, retries/lease fencing, cancellation/restart, FAQ once/follow-up escalation, approval privacy, permanent adapter rejection and converted/terminal suppression. No URL means skip, never PostgreSQL verification success. Fixtures mirror SQL contracts; actual migration/FK validation and real AI/source validation belong to server integration tests. Worker unit tests cover polling/shutdown and generic error reporting without simulating PostgreSQL guarantees.

TASK556 changes are code/test authoring only: this agent ran no install/clean/lock/test/typecheck/build. No AI dependency was added, and the unused ./ai-adapter export was removed as directed.
