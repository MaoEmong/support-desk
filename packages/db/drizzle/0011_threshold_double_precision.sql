-- Explicit data normalization policy, NOT bit-for-bit preservation:
-- Existing float4 ai_threshold values are rounded to FOUR decimal places,
-- changing their values to remove historic float4 representation noise.
-- This policy applies only to tenant_settings.ai_threshold, not AI confidence.
ALTER TABLE tenant_settings ALTER COLUMN ai_threshold TYPE double precision
  USING round(ai_threshold::numeric, 4)::double precision;
