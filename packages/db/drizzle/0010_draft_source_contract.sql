-- A converted SSE draft keeps its conversation provenance and gains ticket_id.
ALTER TABLE ai_drafts DROP CONSTRAINT ai_drafts_target;
ALTER TABLE ai_drafts ADD CONSTRAINT ai_drafts_source
  CHECK ((job_id IS NOT NULL)::int + (conversation_id IS NOT NULL)::int = 1);
ALTER TABLE ai_drafts ADD CONSTRAINT ai_drafts_conversation_unique UNIQUE(conversation_id);
-- Existing job_id UNIQUE and tenant/run FKs are retained.
-- Conversion: UPDATE ai_drafts SET ticket_id = ... WHERE conversation_id = ...;
-- Do not clear conversation_id, replace run_id, or regenerate the draft.
