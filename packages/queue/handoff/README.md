# API-team handoff (reference text only)

The confirmed architecture is `{ db, processInquiry, close? }` injection. Queue has no AI or web imports. The executable loads an API-owned Node-safe module exporting `createWorkerDependencies()` via WORKER_BOOTSTRAP_MODULE; the factory returns that exact shape. `@support/queue/worker` exports the WorkerDependencies type without executing the entrypoint.

These text artifacts preserve earlier drafts for adaptation into the API team's `server/ai/queue-adapter.ts` and server integration tests. They are not active queue implementation, exports or tests:

- ai-adapter.ts.txt: complete deep-masked provider JSON, flattened metrics, both source-array tenant checks, actual AI processInquiry invocation and typed retry/permanent failures. Its former createAIProcessor/PipelineDeps bootstrap proposal is superseded; do not reintroduce it into queue.
- ai-fixtures.ts.txt and adapter.test.ts.txt: real AI mock-pipeline fixtures, lossless masking and source isolation tests.
- pg-ai-tests.ts.txt: earlier PostgreSQL suite containing real-pipeline FAQ once/follow-up, pending approval privacy, foreign KB rejection and provider retry cases. The API team can adapt only those cases into server-owned integration coverage.

Queue's ProcessInquiry accepts ticket/message identity, kind and pipelineVersion. Regeneration has messageId null, so the server adapter owns tenant-scoped message resolution. Return queue AIRunResult with body/action and flattened analysis plus optional aiResult containing the full masked provider result. To preserve masked analysis on failure throw ProcessorFailure(code, maskedResult, permanent). Decision pending_approval remains a decision; database draft status stays draft. Canonical identity columns come exclusively from the locked DB job.

These drafts were authored but never tested, built or typechecked by the queue agent. They do not prove real AI or PostgreSQL correctness.
