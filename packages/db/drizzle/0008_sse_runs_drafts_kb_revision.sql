-- SSE executes without a queue job. Keep existing queue uniqueness and tenant FKs.
ALTER TABLE tenant_settings ADD COLUMN kb_revision integer NOT NULL DEFAULT 0;
ALTER TABLE tenant_settings ADD CONSTRAINT settings_kb_revision CHECK (kb_revision >= 0);

ALTER TABLE ai_runs ALTER COLUMN job_id DROP NOT NULL;
ALTER TABLE ai_runs ADD CONSTRAINT ai_runs_sse_message CHECK (job_id IS NOT NULL OR message_id IS NOT NULL);
CREATE UNIQUE INDEX ai_runs_sse_conversation_message
  ON ai_runs(tenant_id, conversation_id, message_id, pipeline_version)
  WHERE job_id IS NULL AND conversation_id IS NOT NULL;
CREATE UNIQUE INDEX ai_runs_sse_ticket_message
  ON ai_runs(tenant_id, ticket_id, message_id, pipeline_version)
  WHERE job_id IS NULL AND ticket_id IS NOT NULL;
-- Existing ai_runs target XOR is retained.

ALTER TABLE ai_drafts ALTER COLUMN job_id DROP NOT NULL;
ALTER TABLE ai_drafts ALTER COLUMN ticket_id DROP NOT NULL;
ALTER TABLE ai_drafts ADD COLUMN conversation_id uuid;
ALTER TABLE ai_drafts ADD CONSTRAINT ai_drafts_conversation_tenant_fk
  FOREIGN KEY (tenant_id, conversation_id) REFERENCES conversations(tenant_id, id);
ALTER TABLE ai_drafts ADD CONSTRAINT ai_drafts_target
  CHECK ((ticket_id IS NOT NULL)::int + (conversation_id IS NOT NULL)::int = 1);
ALTER TABLE ai_drafts ADD CONSTRAINT ai_drafts_run_or_job CHECK (job_id IS NOT NULL OR run_id IS NOT NULL);
-- Conversion updates this SAME row: SET ticket_id = ..., conversation_id = NULL.
-- run_id, draft id, body and version history are preserved; no regeneration.
