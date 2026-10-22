-- Final agreed storage names and SQL scalar type.
ALTER TABLE tenant_settings ALTER COLUMN ai_threshold TYPE real USING ai_threshold::real;
ALTER TABLE audit_log RENAME COLUMN resource_type TO target_type;
ALTER TABLE audit_log RENAME COLUMN resource_id TO target_id;
ALTER TABLE audit_log RENAME COLUMN metadata TO meta;
ALTER TABLE audit_log ALTER COLUMN meta DROP NOT NULL;
