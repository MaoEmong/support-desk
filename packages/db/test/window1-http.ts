import assert from 'node:assert/strict';
import type { Pool } from 'pg';
import { getDemoCase } from '@support/ai/data';
import { AIRunResultSchema } from '@support/ai/contracts';
import { CreateAgentResponseSchema, SourceSchema } from '../../contracts/src/index';

export class HttpClient {
  cookies = new Map<string, string>();
  csrf = '';
  constructor(readonly base: string) {}
  async request(path: string, method = 'GET', body?: unknown) {
    const headers: Record<string, string> = { origin: this.base, cookie: [...this.cookies].map(([key, value]) => `${key}=${value}`).join('; ') };
    if (body !== undefined) headers['content-type'] = 'application/json';
    if (this.csrf) headers['x-csrf-token'] = this.csrf;
    const response = await fetch(`${this.base}/api${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    for (const cookie of response.headers.getSetCookie()) { const pair = cookie.split(';')[0]; const at = pair.indexOf('='); this.cookies.set(pair.slice(0, at), pair.slice(at + 1)); }
    const text = await response.text();
    const json = text && !response.headers.get('content-type')?.includes('event-stream') ? JSON.parse(text) : null;
    if (json?.csrfToken) this.csrf = json.csrfToken;
    return { status: response.status, text, json };
  }
  async login(slug: string, local: string) {
    assert.equal((await this.request(`/t/${slug}/auth/login`, 'POST', { email: `${local}@${slug}.example.com`, password: process.env.SEED_PASSWORD ?? 'DemoPassword123!' })).status, 200);
    assert(this.csrf);
  }
}
export async function until<T>(operation: () => Promise<T | undefined>, label: string, timeout = 30000): Promise<T> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { const result = await operation(); if (result !== undefined) return result; await new Promise(resolve => setTimeout(resolve, 250)); }
  throw new Error(`Timed out: ${label}`);
}
export async function runHttpChecks(base: string, pool: Pool, record: (value: unknown) => void) {
  const customer = new HttpClient(base), admin = new HttpClient(base);
  await customer.login('pixelforge', 'customer1'); await admin.login('pixelforge', 'admin');
  const demo = getDemoCase('pixelforge', 'faq_install');
  const create = async () => {
    const response = await customer.request('/t/pixelforge/tickets', 'POST', { title: demo.title, body: demo.message });
    assert.equal(response.status, 201); return response.json.id as string;
  };
  const ticketId = await create();
  const job = await until(async () => (await pool.query("SELECT * FROM ai_jobs WHERE ticket_id=$1 AND status IN ('succeeded','failed')", [ticketId])).rows[0], 'real FAQ worker job');
  assert.equal(job.status, 'succeeded');
  const { rows: [run] } = await pool.query('SELECT * FROM ai_runs WHERE job_id=$1', [job.id]);
  assert.equal(run.decision, demo.expected.decision); assert.equal(run.reason, demo.expected.reason);
  assert.equal(run.category, demo.expected.category); assert(Math.abs(run.confidence - demo.expected.confidence) <= 0.0005);
  const detail = await customer.request(`/t/pixelforge/tickets/${ticketId}`);
  const replies = detail.json.messages.filter((message: { authorType: string }) => message.authorType === 'ai');
  assert.equal(replies.length, 1); assert(replies[0].sources.length > 0);
  replies[0].sources.forEach((source: unknown) => SourceSchema.parse(source));
  record({ caseKey: demo.key, override: {}, autoAnswerCount: 0, jobId: job.id, ticketId, decision: run.decision, reason: run.reason, category: run.category, confidence: run.confidence, publicReplies: replies.length });
  assert.equal((await customer.request(`/t/pixelforge/tickets/${ticketId}/messages`, 'POST', { body: demo.message })).status, 201);
  await until(async () => { const row = (await pool.query('SELECT escalated_at FROM tickets WHERE id=$1', [ticketId])).rows[0]; return row.escalated_at ? true : undefined; }, 'follow-up escalation');
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM ticket_messages WHERE ticket_id=$1 AND role='ai'", [ticketId])).rows[0].n, 1);
  record({ caseKey: 'follow_up_after_auto_answer', ticketId, publicReplies: 1, escalated: true });

  assert.equal((await admin.request('/t/pixelforge/admin/settings', 'PATCH', { approvalMode: true })).status, 200);
  const approvalTicket = await create();
  await until(async () => (await pool.query("SELECT * FROM ai_jobs WHERE ticket_id=$1 AND status='succeeded'", [approvalTicket])).rows[0], 'approval-mode worker');
  const hidden = await customer.request(`/t/pixelforge/tickets/${approvalTicket}`);
  assert.equal(hidden.json.messages.filter((message: { authorType: string }) => message.authorType === 'ai').length, 0);
  assert(!('drafts' in hidden.json)); assert(!('aiRuns' in hidden.json));
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM ai_drafts WHERE ticket_id=$1', [approvalTicket])).rows[0].n, 1);
  const { rows: [approvalRun] } = await pool.query('SELECT * FROM ai_runs WHERE ticket_id=$1', [approvalTicket]);
  record({ caseKey: demo.key, override: { approvalMode: true }, autoAnswerCount: 0, ticketId: approvalTicket, jobId: approvalRun.job_id, decision: approvalRun.decision, reason: approvalRun.reason, category: approvalRun.category, confidence: approvalRun.confidence, draftCount: 1, customerDraftVisible: false });
  assert.equal((await admin.request('/t/pixelforge/admin/settings', 'PATCH', { approvalMode: false })).status, 200);

  const { rows: [setting] } = await pool.query("SELECT tenant_id,categories FROM tenant_settings WHERE tenant_id=(SELECT id FROM tenants WHERE slug='pixelforge')");
  let invalidTicket: string | undefined;
  try {
    // Deliberately invalid configuration exercises the real pipeline's permanent
    // CONFIG_ERROR path, without changing provider behavior or exposing text.
    await pool.query("UPDATE tenant_settings SET categories='[]'::jsonb WHERE tenant_id=$1", [setting.tenant_id]);
    invalidTicket = await create();
    const failed = await until(async () => (await pool.query("SELECT * FROM ai_jobs WHERE ticket_id=$1 AND status='failed'", [invalidTicket])).rows[0], 'permanent settings error');
    assert.equal(failed.attempts, 1);
    const { rows: [failedRun] } = await pool.query('SELECT confidence,result FROM ai_runs WHERE job_id=$1', [failed.id]);
    // Queue stores its adapter envelope; the original pipeline JSON is aiResult.
    const original = AIRunResultSchema.parse(failedRun.result.aiResult);
    assert.equal(failedRun.confidence, 0); assert.equal(original.draft, null);
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM ai_drafts WHERE ticket_id=$1', [invalidTicket])).rows[0].n, 0);
    assert.equal((await pool.query("SELECT count(*)::int AS n FROM ticket_messages WHERE ticket_id=$1 AND role='ai'", [invalidTicket])).rows[0].n, 0);
    record({ caseKey: 'permanent_config_error', jobId: failed.id, attempts: 1, confidence: 0, nullDraft: true, draftCount: 0, publicReplies: 0 });
  } finally {
    await pool.query('UPDATE tenant_settings SET categories=$2::jsonb WHERE tenant_id=$1', [setting.tenant_id, JSON.stringify(setting.categories)]);
  }

  const chatDemo = getDemoCase('pixelforge', 'faq_install');
  const sse = await customer.request('/t/pixelforge/chat', 'POST', { body: chatDemo.message });
  assert.equal(sse.status, 200);
  const events = sse.text.split(/\r?\n\r?\n/).filter(block => block.startsWith('event:')).map(block => {
    const lines = block.split(/\r?\n/); return { event: lines[0].slice(7), data: JSON.parse(lines.find(line => line.startsWith('data:'))!.slice(6)) };
  });
  assert.deepEqual(events.slice(0, 2).map(event => event.event), ['classified', 'sources']);
  assert.equal(events.at(-1)?.event, 'done');
  const done = events.at(-1)!.data;
  assert(Object.keys(done).every(key => ['conversationId', 'messageId', 'ticketId'].includes(key)));
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM conversation_messages WHERE conversation_id=$1 AND role='assistant'", [done.conversationId])).rows[0].n, 1);
  for (const field of ['confidence', 'urgency', 'sentiment', 'tenantId', 'score', 'summary']) assert(!sse.text.includes(`"${field}"`));
  record({ caseKey: 'http_sse_auto_answer', eventOrder: events.map(event => event.event), conversationId: done.conversationId, savedAssistant: 1 });

  const email = `window1-${Date.now()}@example.test`;
  const created = await admin.request('/t/pixelforge/admin/agents', 'POST', { name: 'Window1 Agent', email });
  assert.equal(created.status, 201); CreateAgentResponseSchema.parse(created.json);
  const newId = created.json.agent.id;
  assert.equal((await admin.request('/t/pixelforge/admin/agents', 'POST', { name: 'duplicate', email })).status, 409);
  const listed = await admin.request('/t/pixelforge/admin/agents');
  assert(listed.json.items.some((agent: { id: string; status: string; assignedOpenCount: number }) => agent.id === newId && agent.status === 'active' && agent.assignedOpenCount === 0));
  assert(!listed.text.includes('temporaryPassword'));
  assert.equal((await admin.request(`/t/pixelforge/admin/agents/${newId}`, 'PATCH', { status: 'disabled' })).status, 200);
  assert.equal((await pool.query('SELECT status FROM users WHERE id=$1', [newId])).rows[0].status, 'disabled');
  assert.equal((await admin.request(`/t/pixelforge/admin/agents/${newId}`, 'PATCH', { status: 'active' })).status, 400);
  record({ caseKey: 'agents_pg_http', agentId: newId, createStatus: 201, duplicateStatus: 409, disabled: true, passwordLogged: false });
  return { customer, admin, create, tenantSlug: 'pixelforge' };
}
