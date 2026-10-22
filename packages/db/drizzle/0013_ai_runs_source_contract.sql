-- Inspect before changing constraints. Unknown provenance must be resolved
-- explicitly by an operator; never delete rows or manufacture queue jobs.
DO $$
DECLARE invalid_sources bigint; invalid_workers bigint;
BEGIN
  SELECT count(*) INTO invalid_sources FROM ai_runs
  WHERE (job_id IS NOT NULL)::int + (conversation_id IS NOT NULL)::int <> 1;
  SELECT count(*) INTO invalid_workers FROM ai_runs
  WHERE job_id IS NOT NULL AND ticket_id IS NULL;
  IF invalid_sources > 0 OR invalid_workers > 0 THEN
    RAISE EXCEPTION 'ai_runs provenance needs explicit backfill: invalid_sources=%, worker_without_ticket=%', invalid_sources, invalid_workers;
  END IF;
END $$;

-- This is the unnamed table CHECK created by canonical migration 0000.
ALTER TABLE ai_runs DROP CONSTRAINT ai_runs_check;
ALTER TABLE ai_runs ADD CONSTRAINT ai_runs_source
  CHECK ((job_id IS NOT NULL)::int + (conversation_id IS NOT NULL)::int = 1);
ALTER TABLE ai_runs ADD CONSTRAINT ai_runs_worker_ticket
  CHECK (job_id IS NULL OR ticket_id IS NOT NULL);
-- Existing nullable job UNIQUE, tenant FKs, SSE message/pipeline uniqueness and
-- message requirement remain. Conversion adds ticket_id to the SAME SSE run,
-- retaining its id, conversation_id, message_id and pipeline_version.
