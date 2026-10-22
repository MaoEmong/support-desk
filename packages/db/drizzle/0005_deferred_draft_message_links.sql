-- Approval updates the draft and inserts its sent message in one transaction.
-- Validate cyclic references at commit, regardless of statement order.
ALTER TABLE ai_drafts ALTER CONSTRAINT ai_drafts_sent_tenant_fk DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE ticket_messages ALTER CONSTRAINT ticket_messages_draft_tenant_fk DEFERRABLE INITIALLY DEFERRED;
