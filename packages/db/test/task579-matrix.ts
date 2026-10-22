import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import type { Pool } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { getDemoCase } from '@support/ai/data';
import { AIRunResultSchema } from '@support/ai/contracts';
import { enqueueInquiry } from '../../queue/src/index';
import * as schema from '../src/schema';
import { HttpClient, until } from './window1-http';

const keys = {
  pixelforge: ['faq_install', 'refund_escalate', 'hacking_escalate', 'sanction_escalate', 'approval_pending', 'chat_faq', 'chat_hacking', 'threshold_boundary'],
  mailpulse: ['faq_campaign', 'refund_escalate', 'account_security_escalate', 'chat_faq', 'chat_account_security', 'threshold_boundary'],
};
export async function runMatrix(base: string, pool: Pool, output: string) {
  const descriptors = Object.entries(keys).flatMap(([slug, ids]) => ids.map(key => ({ slug, key, probe: false })));
  descriptors.push({ slug: 'pixelforge', key: 'threshold_boundary', probe: true }, { slug: 'mailpulse', key: 'threshold_boundary', probe: true });
  assert.equal(descriptors.filter(item => !item.probe && getDemoCase(item.slug, item.key).channel === 'ticket').length, 10);
  assert.equal(descriptors.filter(item => !item.probe && getDemoCase(item.slug, item.key).channel === 'chat').length, 4);
  const database = drizzle(pool, { schema });
  const clients = new Map<string, HttpClient>();
  const rows: unknown[] = [];
  for (const descriptor of descriptors) {
    const demo = getDemoCase(descriptor.slug, descriptor.key);
    let client = clients.get(descriptor.slug);
    if (!client) { client = new HttpClient(base); await client.login(descriptor.slug, 'customer2'); clients.set(descriptor.slug, client); }
    const { rows: [tenant] } = await pool.query('SELECT id FROM tenants WHERE slug=$1', [descriptor.slug]);
    const { rows: [customer] } = await pool.query('SELECT id FROM users WHERE tenant_id=$1 AND email=$2', [tenant.id, `customer2@${descriptor.slug}.example.com`]);
    const { rows: [before] } = await pool.query('SELECT ai_threshold,approval_mode FROM tenant_settings WHERE tenant_id=$1', [tenant.id]);
    const override = { ...demo.settingsOverride, ...(descriptor.probe ? { threshold: demo.thresholdProbe!.threshold } : {}) };
    let stored: Record<string, unknown>, identity: { jobId?: string; conversationId?: string };
    try {
      await pool.query('UPDATE tenant_settings SET ai_threshold=$2,approval_mode=$3 WHERE tenant_id=$1', [tenant.id, override.threshold ?? before.ai_threshold, override.approvalMode ?? before.approval_mode]);
      if (demo.channel === 'ticket') {
        const ticketId = randomUUID(), messageId = randomUUID();
        const jobId = await database.transaction(async tx => {
          await tx.insert(schema.tickets).values({ id: ticketId, tenantId: tenant.id, customerId: customer.id, title: demo.title, body: demo.message, autoReplyCount: 0 });
          await tx.insert(schema.ticketMessages).values({ id: messageId, tenantId: tenant.id, ticketId, authorId: customer.id, role: 'customer', authorType: 'customer', body: demo.message, visibility: 'public' });
          const id = await enqueueInquiry(tx, { tenantId: tenant.id, ticketId, messageId, idempotencyKey: `matrix:${ticketId}` });
          await tx.execute((await import('drizzle-orm')).sql`update ai_jobs set available_at=now()+interval '1 day' where id=${id}`);
          return id;
        });
        assert.equal((await pool.query('SELECT auto_reply_count FROM tickets WHERE id=$1', [ticketId])).rows[0].auto_reply_count, 0);
        await pool.query('UPDATE ai_jobs SET available_at=now() WHERE id=$1', [jobId]);
        await until(async () => (await pool.query("SELECT status FROM ai_jobs WHERE id=$1 AND status IN('succeeded','failed')", [jobId])).rows[0], `matrix worker ${descriptor.slug}/${demo.key}`);
        stored = (await pool.query('SELECT result FROM ai_runs WHERE job_id=$1', [jobId])).rows[0].result;
        identity = { jobId };
      } else {
        const conversationId = randomUUID();
        await pool.query('INSERT INTO conversations(id,tenant_id,customer_id) VALUES($1,$2,$3)', [conversationId, tenant.id, customer.id]);
        assert.equal((await pool.query("SELECT count(*)::int AS n FROM conversation_messages WHERE conversation_id=$1 AND role='assistant'", [conversationId])).rows[0].n, 0);
        const response = await client.request(`/t/${descriptor.slug}/chat`, 'POST', { conversationId, body: demo.message });
        assert.equal(response.status, 200);
        const { rows: runs } = await pool.query('SELECT result,job_id FROM ai_runs WHERE conversation_id=$1', [conversationId]);
        assert.equal(runs.length, 1); assert.equal(runs[0].job_id, null);
        stored = runs[0].result; identity = { conversationId };
      }
      const raw = AIRunResultSchema.parse(stored.aiResult);
      const row = { tenantSlug: descriptor.slug, caseKey: demo.key, channel: descriptor.probe ? 'probe' : demo.channel, override, autoAnswerCount: 0, ...identity, decision: raw.decision, reason: raw.reason, category: raw.classification?.category ?? null, confidence: raw.confidence.final };
      rows.push(row); writeFileSync(output, JSON.stringify(rows, null, 2)); console.log(JSON.stringify(row));
      const expected = descriptor.probe ? { ...demo.expected, decision: demo.thresholdProbe!.decision, reason: demo.thresholdProbe!.reason } : demo.expected;
      assert.equal(raw.decision, expected.decision, `${descriptor.slug}/${demo.key} decision`);
      assert.equal(raw.reason, expected.reason, `${descriptor.slug}/${demo.key} reason`);
      assert.equal(raw.classification?.category, expected.category, `${descriptor.slug}/${demo.key} category`);
      assert(Math.abs(raw.confidence.final - expected.confidence) <= 0.0005, `${descriptor.slug}/${demo.key} confidence`);
    } finally {
      await pool.query('UPDATE tenant_settings SET ai_threshold=$2,approval_mode=$3 WHERE tenant_id=$1', [tenant.id, before.ai_threshold, before.approval_mode]);
      const { rows: [restored] } = await pool.query('SELECT ai_threshold,approval_mode FROM tenant_settings WHERE tenant_id=$1', [tenant.id]);
      assert.deepEqual(restored, before);
    }
  }
  assert.equal(rows.length, 16);
}
