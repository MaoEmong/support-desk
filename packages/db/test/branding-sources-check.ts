import { config, parse } from 'dotenv';
import { readFileSync } from 'node:fs';
import { Pool } from 'pg';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { runMigrations } from '../src/migrations';

config({ path: fileURLToPath(new URL('../../../.env', import.meta.url)), quiet: true });
const example = parse(readFileSync(new URL('../../../.env.example', import.meta.url)));
const target = new URL(process.env.DATABASE_URL ?? example.DATABASE_URL);
if (!process.env.DATABASE_URL) target.port = '55432';
assert(['localhost', '127.0.0.1', '[::1]'].includes(target.hostname));
const name = `support_branding_${Date.now()}_e2e`;
assert(/^support_branding_[0-9]+_e2e$/.test(name));
const ownership = `branding-sources-check:${randomUUID()}`;
const maintenance = new URL(target); maintenance.pathname = '/postgres';
const admin = new Pool({ connectionString: maintenance.toString(), max: 1 });
let pool: Pool | undefined;
let appPool: Pool | undefined;
let created = false;
try {
  await admin.query(`CREATE DATABASE "${name}"`); created = true;
  await admin.query(`COMMENT ON DATABASE "${name}" IS '${ownership}'`);
  target.pathname = `/${name}`;
  pool = new Pool({ connectionString: target.toString(), max: 1 });
  console.log(`Created owned independent empty DB ${name}`);
  await runMigrations(pool);
  const seed = () => execFileSync(process.execPath, [fileURLToPath(new URL('../node_modules/tsx/dist/cli.mjs', import.meta.url)), fileURLToPath(new URL('../src/seed.ts', import.meta.url))], { env: { ...process.env, DATABASE_URL: target.toString() }, stdio: 'inherit' });
  seed();
  process.env.DATABASE_URL = target.toString();
  const mod = await import('../src/index'); appPool = mod.pool;
  const { DrizzleRepo } = await import('../../../apps/web/src/server/repo/drizzle');
  const dto = await import('../../../apps/web/src/server/dto');
  const contracts = await import('../../contracts/src/index');
  const repo = new DrizzleRepo(mod.db);
  const expected = { pixelforge: '#7c3aed', mailpulse: '#2563eb' };
  for (const [slug, color] of Object.entries(expected)) {
    const tenant = await repo.getTenantBySlug(slug); assert(tenant);
    const settings = await repo.getSettings(tenant.id); assert(settings);
    assert.equal(settings.primaryColor, color);
    const publicSettings = dto.toPublicSettings(tenant, settings, 'mock');
    contracts.PublicTenantSettingsSchema.parse(publicSettings);
    assert.equal(publicSettings.primaryColor, color);
    assert(publicSettings.categories.every(category => Object.keys(category).sort().join(',') === 'id,label'));
    assert(!('aiSystemPrompt' in publicSettings));
    console.log(`Brand DB -> API DTO ${slug} ${color}: PASS`);
    const { rows: messages } = await pool.query("SELECT ticket_id FROM ticket_messages WHERE tenant_id=$1 AND role='ai'", [tenant.id]);
    assert(messages.length > 0);
    for (const message of messages) {
      const rows = await repo.listTicketMessages(tenant.id, message.ticket_id);
      for (const row of rows.filter(row => row.authorType === 'ai')) {
        for (const source of row.sources ?? []) assert(Object.keys(source).every(key => ['id', 'kbArticleId', 'title', 'excerpt', 'url'].includes(key)));
        const publicMessage = dto.toCustomerMessage(row, { users: new Map(), chatbotName: settings.chatbotName });
        assert(publicMessage.sources.length > 0);
        publicMessage.sources.forEach(source => contracts.SourceSchema.parse(source));
        const encoded = JSON.stringify(publicMessage);
        for (const field of ['tenantId', 'score', 'confidence', 'classification', 'reasonDetail', 'summary']) assert(!encoded.includes(`"${field}"`));
      }
    }
    console.log(`Seeded public sources stored DB -> API DTO ${slug}: PASS`);
    const conv = randomUUID(), msg = randomUUID();
    const { rows: [customer] } = await pool.query("SELECT id FROM users WHERE tenant_id=$1 AND role='customer' LIMIT 1", [tenant.id]);
    await pool.query('INSERT INTO conversations(id,tenant_id,customer_id) VALUES($1,$2,$3)', [conv, tenant.id, customer.id]);
    await pool.query("INSERT INTO conversation_messages(id,tenant_id,conversation_id,role,body,reason,notice_code) VALUES($1,$2,$3,'system','안내','approval_mode','APPROVAL_REQUIRED')", [msg, tenant.id, conv]);
    const restored = dto.toConversationMessage((await repo.listConversationMessages(tenant.id, conv))[0]);
    // HTTP JSON serialization turns Date values into ISO strings.
    contracts.ConversationMessageSchema.parse(JSON.parse(JSON.stringify(restored)));
    assert.equal(restored.escalationReason, 'approval_mode'); assert(!('reason' in restored));
    assert.equal(restored.noticeCode, 'APPROVAL_REQUIRED');
    console.log(`System DB reason -> public escalationReason ${slug}: PASS`);
  }
  const raw = [{ kbArticleId: randomUUID(), tenantId: 'own', title: 'FAQ', excerpt: 'public excerpt', url: 'https://example.test/faq', score: 0.9, confidence: 0.99, summary: 'private' }, { kbArticleId: randomUUID(), tenantId: 'foreign', title: 'private' }];
  const projected = dto.storedPublicSources('own', raw);
  assert.equal(projected.length, 1);
  assert.deepEqual(Object.keys(projected[0]).sort(), ['id', 'title', 'excerpt', 'url'].sort());
  console.log('Source allowlist strips analysis and excludes foreign tenant: PASS');
  await pool.query("UPDATE tenant_settings SET primary_color='#123456' WHERE tenant_id=(SELECT id FROM tenants WHERE slug='pixelforge')");
  seed();
  const { rows: [preserved] } = await pool.query("SELECT primary_color FROM tenant_settings WHERE tenant_id=(SELECT id FROM tenants WHERE slug='pixelforge')");
  assert.equal(preserved.primary_color, '#123456');
  console.log('Reseed preserves administrator branding: PASS');
} finally {
  await appPool?.end(); await pool?.end();
  if (created) {
    const { rows: [owned] } = await admin.query('SELECT shobj_description(oid,\'pg_database\') AS owner FROM pg_database WHERE datname=$1', [name]);
    assert.equal(owned?.owner, ownership);
    const { rows: [activity] } = await admin.query('SELECT count(*)::int AS connections FROM pg_stat_activity WHERE datname=$1', [name]);
    assert.equal(activity.connections, 0, 'Refuse cleanup while any target connection remains');
    await admin.query(`DROP DATABASE "${name}"`);
    console.log(`Dropped only verified owned DB ${name}; shared DB untouched`);
  }
  await admin.end();
}
