-- Preserve existing UUID target identifiers as text, and permit non-UUID resources.
ALTER TABLE audit_log ALTER COLUMN target_id TYPE text USING target_id::text;
