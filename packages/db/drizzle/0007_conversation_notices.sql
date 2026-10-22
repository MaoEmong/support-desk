ALTER TABLE conversation_messages ADD COLUMN reason text, ADD COLUMN notice_code text;
ALTER TABLE conversation_messages ADD CONSTRAINT conversation_notice_code CHECK(notice_code IS NULL OR notice_code IN ('APPROVAL_REQUIRED','ESCALATED','PROCESSING_FAILED'));
-- Existing tenant-composite references, source_job_id uniqueness and ai_jobs/ai_runs
-- ticket/conversation XOR checks remain in effect; no source reference is dropped.
