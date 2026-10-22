ALTER TABLE conversation_messages DROP CONSTRAINT conversation_messages_role_check;
UPDATE conversation_messages SET role=CASE role WHEN 'customer' THEN 'user' WHEN 'ai' THEN 'assistant' ELSE role END;
ALTER TABLE conversation_messages ADD CONSTRAINT conversation_message_role CHECK(role IN ('user','assistant','system'));
ALTER TABLE ai_jobs ALTER COLUMN message_id DROP NOT NULL;
ALTER TABLE ai_jobs ADD CONSTRAINT ai_jobs_process_message CHECK(kind <> 'process_inquiry' OR message_id IS NOT NULL);
CREATE OR REPLACE FUNCTION validate_job_message() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.message_id IS NULL THEN
   IF NEW.kind='process_inquiry' THEN RAISE EXCEPTION 'process_inquiry requires message_id' USING ERRCODE='23514'; END IF;
   RETURN NEW;
 END IF;
 IF NEW.ticket_id IS NOT NULL THEN
   IF NOT EXISTS (SELECT 1 FROM ticket_messages WHERE id=NEW.message_id AND tenant_id=NEW.tenant_id AND ticket_id=NEW.ticket_id) THEN RAISE EXCEPTION 'job message does not belong to ticket' USING ERRCODE='23503'; END IF;
 ELSE
   IF NOT EXISTS (SELECT 1 FROM conversation_messages WHERE id=NEW.message_id AND tenant_id=NEW.tenant_id AND conversation_id=NEW.conversation_id) THEN RAISE EXCEPTION 'job message does not belong to conversation' USING ERRCODE='23503'; END IF;
 END IF;
 RETURN NEW;
END $$;
