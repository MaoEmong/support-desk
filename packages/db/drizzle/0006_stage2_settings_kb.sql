-- Forward-only: preserve administrator settings and normalize the legacy string[] shape.
ALTER TABLE tenant_settings ADD COLUMN auto_answer_limit integer NOT NULL DEFAULT 1, ADD COLUMN fallback_category text NOT NULL DEFAULT 'other';
ALTER TABLE tenant_settings ADD CONSTRAINT settings_auto_answer_limit CHECK(auto_answer_limit BETWEEN 0 AND 1);
ALTER TABLE tenant_settings ALTER COLUMN forbidden_categories SET DEFAULT '[]'::jsonb;
DO $$ BEGIN
  IF EXISTS(SELECT 1 FROM tenant_settings WHERE jsonb_typeof(categories) <> 'array') THEN
    RAISE EXCEPTION 'tenant_settings.categories must be an array before backfill';
  END IF;
END $$;
UPDATE tenant_settings s SET categories = COALESCE((
  SELECT jsonb_agg(CASE WHEN jsonb_typeof(item)='string' THEN jsonb_build_object('id',item #>> '{}','label',item #>> '{}','keywords','[]'::jsonb) ELSE item END ORDER BY position)
  FROM jsonb_array_elements(s.categories) WITH ORDINALITY AS entry(item,position)
), '[]'::jsonb);
-- Preserve forbidden ids that legacy settings allowed outside the old categories list.
UPDATE tenant_settings s SET categories = s.categories || COALESCE((
  SELECT jsonb_agg(jsonb_build_object('id',required_id,'label',CASE WHEN required_id='other' THEN '기타' ELSE required_id END,'keywords','[]'::jsonb))
  FROM (SELECT DISTINCT value AS required_id FROM jsonb_array_elements_text(s.forbidden_categories) UNION SELECT s.fallback_category) required
  WHERE NOT EXISTS(SELECT 1 FROM jsonb_array_elements(s.categories) c WHERE c->>'id'=required.required_id)
), '[]'::jsonb);
ALTER TABLE tenant_settings ALTER COLUMN categories SET DEFAULT '[{"id":"other","label":"기타","keywords":[]}]'::jsonb;
ALTER TABLE tenant_settings ADD CONSTRAINT settings_categories_array CHECK(jsonb_typeof(categories)='array');
ALTER TABLE kb_articles ADD COLUMN revision integer NOT NULL DEFAULT 1 CHECK(revision > 0), ADD COLUMN question text NOT NULL DEFAULT '';
UPDATE kb_articles SET question=title WHERE question='';
