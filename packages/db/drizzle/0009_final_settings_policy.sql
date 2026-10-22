-- Correct earlier drafts without editing migration history.
ALTER TABLE tenant_settings DROP CONSTRAINT settings_auto_answer_limit;
UPDATE tenant_settings SET auto_answer_limit = 1 WHERE auto_answer_limit <> 1;
ALTER TABLE tenant_settings ADD CONSTRAINT settings_auto_answer_limit CHECK (auto_answer_limit = 1);
ALTER TABLE tenant_settings ALTER COLUMN fallback_category DROP DEFAULT;

-- AI data/tenants/{pixelforge,mailpulse}/settings.json both specify "other".
-- Preserve already-valid administrator choices; repair only invalid known demo rows.
UPDATE tenant_settings s SET fallback_category = 'other'
FROM tenants t
WHERE t.id = s.tenant_id AND t.slug IN ('pixelforge', 'mailpulse')
  AND EXISTS (SELECT 1 FROM jsonb_array_elements(s.categories) c WHERE c->>'id' = 'other')
  AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(s.categories) c WHERE c->>'id' = s.fallback_category);
-- Unknown/undetermined tenants fail explicitly, requiring an operator-selected valid ID.
DO $$ BEGIN
  IF EXISTS (
    SELECT 1 FROM tenant_settings s
    WHERE NOT EXISTS (SELECT 1 FROM jsonb_array_elements(s.categories) c WHERE c->>'id' = s.fallback_category)
  ) THEN
    RAISE EXCEPTION 'Choose an explicit valid fallback_category for each tenant before migration 0009';
  END IF;
END $$;

-- Keep kb_articles.revision for API optimistic updates; kb_revision invalidates tenant KB caches.
