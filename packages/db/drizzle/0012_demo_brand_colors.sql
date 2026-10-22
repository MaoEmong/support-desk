-- Fill only missing demo branding; preserve existing administrator colors.
UPDATE tenant_settings s
SET primary_color = CASE t.slug WHEN 'pixelforge' THEN '#7c3aed' WHEN 'mailpulse' THEN '#2563eb' END
FROM tenants t
WHERE t.id = s.tenant_id AND t.slug IN ('pixelforge', 'mailpulse') AND s.primary_color IS NULL;
