import assert from 'node:assert/strict';
import type { Pool } from 'pg';
import { randomUUID } from 'node:crypto';
import { getDemoCase } from '@support/ai/data';
import { ConversationMessageSchema, CreateAgentResponseSchema, SSEEventSchema } from '../../contracts/src/index';
import { HttpClient } from './window1-http';

const INTERNAL_KEYS = ['confidence', 'urgency', 'sentiment', 'summary', 'score', 'tenantId', 'reasonDetail', 'decision', 'usage', 'pipelineVersion'];
export function events(wire: string) {
  return wire.split(/\r?\n\r?\n/).filter(block => block.startsWith('event:')).map(block => {
    const lines = block.split(/\r?\n/);
    return SSEEventSchema.parse({ event: lines[0].slice(7), data: JSON.parse(lines.find(line => line.startsWith('data:'))!.slice(6)) });
  });
}
function noInternal(wire: string) {
  for (const key of [...INTERNAL_KEYS, 'result', 'aiResult', 'draft']) assert(!wire.includes(`"${key}"`), `Public response includes internal key ${key}`);
}
export async function extraHttp(base: string, pool: Pool, record: (value: unknown) => void, options: { sseOnly?: boolean } = {}) {
  const customer = new HttpClient(base), admin = new HttpClient(base);
  await customer.login('pixelforge', 'customer1'); await admin.login('pixelforge', 'admin');
  let clickTicket = '', approvalTicket = '';
  if (process.env.TASK579_HTTP_REMAINING === '1') {
    const { rows: [fixture] } = await pool.query("SELECT t.id AS tenant,u.id AS customer FROM tenants t JOIN users u ON u.tenant_id=t.id WHERE t.slug='pixelforge' AND u.email='customer1@pixelforge.example.com'");
    clickTicket = randomUUID(); approvalTicket = randomUUID();
    const official = getDemoCase('pixelforge', 'faq_install');
    for (const id of [clickTicket, approvalTicket]) await pool.query('INSERT INTO tickets(id,tenant_id,customer_id,title,body) VALUES($1,$2,$3,$4,$5)', [id, fixture.tenant, fixture.customer, official.title, official.message]);
    record({ check: 'confirmed_sse_not_repeated', priorEvidence: 'attempt2/results.json', currentPassClaim: false });
  } else {
  const hacking = getDemoCase('pixelforge', 'chat_hacking');
  const forbidden = await customer.request('/t/pixelforge/chat', 'POST', { body: hacking.message });
  assert.equal(forbidden.status, 200); noInternal(forbidden.text);
  const stream = events(forbidden.text); assert.equal(stream.filter(event => event.event === 'token').length, 0);
  const done = stream.at(-1)!; assert.equal(done.event, 'done');
  const conversationId = (done.data as { conversationId: string }).conversationId;
  const escalation = stream.find(event => event.event === 'escalated'); assert(escalation?.event === 'escalated');
  assert.equal(escalation.data.reason, 'forbidden_category'); assert(escalation.data.message);
  const restored = await customer.request(`/t/pixelforge/conversations/${conversationId}`);
  noInternal(restored.text);
  const system = restored.json.messages.find((message: { role: string }) => message.role === 'system');
  ConversationMessageSchema.parse(system); assert.equal(system.escalationReason, 'forbidden_category'); assert.equal(system.noticeCode, 'ESCALATED');
  const clicked = await Promise.all([customer.request(`/t/pixelforge/conversations/${conversationId}/convert`, 'POST', { title: hacking.title }), customer.request(`/t/pixelforge/conversations/${conversationId}/convert`, 'POST', { title: hacking.title })]);
  assert.deepEqual(clicked.map(response => response.status).sort(), [200, 201]);
  assert.equal(clicked[0].json.ticketId, clicked[1].json.ticketId);
  clickTicket = clicked[0].json.ticketId;
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM tickets WHERE conversation_id=$1', [conversationId])).rows[0].n, 1);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM ai_jobs WHERE ticket_id=$1 OR conversation_id=$2', [clickTicket, conversationId])).rows[0].n, 0);
  record({ check: 'forbidden_click_conversion', tokenCount: 0, bannedKeyCounts: Object.fromEntries(INTERNAL_KEYS.map(key => [key, 0])), conversationId, doneData: done.data, doneTicketId: (done.data as { ticketId?: string }).ticketId ?? null, clickedTicketId: clickTicket, conversionStatuses: [200, 201], ticketCount: 1, workerJobs: 0, escalationReason: system.escalationReason, noticeCode: system.noticeCode });

  const { rows: [settings] } = await pool.query("SELECT tenant_id,approval_mode FROM tenant_settings WHERE tenant_id=(SELECT id FROM tenants WHERE slug='pixelforge')");
  try {
    await pool.query('UPDATE tenant_settings SET approval_mode=true WHERE tenant_id=$1', [settings.tenant_id]);
    const official = getDemoCase('pixelforge', 'faq_install');
    const response = await customer.request('/t/pixelforge/chat', 'POST', { body: official.message });
    assert.equal(response.status, 200); noInternal(response.text);
    const approvalEvents = events(response.text);
    assert.equal(approvalEvents.filter(event => event.event === 'token').length, 0);
    const terminal = approvalEvents.at(-1)!; assert.equal(terminal.event, 'done');
    const data = terminal.data as { conversationId: string; ticketId?: string }; assert(data.ticketId); approvalTicket = data.ticketId;
    const view = await customer.request(`/t/pixelforge/conversations/${data.conversationId}`);
    noInternal(view.text);
    const notice = view.json.messages.find((message: { role: string }) => message.role === 'system');
    assert.equal(notice.escalationReason, 'approval_mode'); assert.equal(notice.noticeCode, 'APPROVAL_REQUIRED');
    const duplicate = await customer.request(`/t/pixelforge/conversations/${data.conversationId}/convert`, 'POST', { title: official.title });
    assert.equal(duplicate.status, 200); assert.equal(duplicate.json.ticketId, approvalTicket);
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM tickets WHERE conversation_id=$1', [data.conversationId])).rows[0].n, 1);
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM ai_jobs WHERE ticket_id=$1 OR conversation_id=$2', [approvalTicket, data.conversationId])).rows[0].n, 0);
    const { rows: drafts } = await pool.query('SELECT id,ticket_id,conversation_id FROM ai_drafts WHERE conversation_id=$1', [data.conversationId]);
    assert.equal(drafts.length, 1); assert.equal(drafts[0].ticket_id, approvalTicket);
    record({ check: 'approval_auto_conversion', conversationId: data.conversationId, doneData: terminal.data, doneTicketId: approvalTicket, duplicateTicketId: duplicate.json.ticketId, ticketCount: 1, workerJobs: 0, draftId: drafts[0].id, draftConversationRetained: true, escalationReason: notice.escalationReason, noticeCode: notice.noticeCode, tokenCount: 0 });
  } finally { await pool.query('UPDATE tenant_settings SET approval_mode=$2 WHERE tenant_id=$1', [settings.tenant_id, settings.approval_mode]); }
  }

  // Only this disposable DB's KB is locked. A normal runtime SSE request stays
  // open until its REAL default 15-second heartbeat comment is received.
  const gate = await pool.connect();
  try {
    // Invalidate the warmed web KB cache before locking the actual loader.
    await pool.query("UPDATE tenant_settings SET kb_revision=kb_revision+1 WHERE tenant_id=(SELECT id FROM tenants WHERE slug='pixelforge')");
    await gate.query('BEGIN'); await gate.query('LOCK TABLE kb_articles IN ACCESS EXCLUSIVE MODE');
    const official = getDemoCase('pixelforge', 'chat_faq'); const started = Date.now();
    const response = await fetch(`${base}/api/t/pixelforge/chat`, { method: 'POST', headers: { origin: base, cookie: [...customer.cookies].map(([key, value]) => `${key}=${value}`).join('; '), 'x-csrf-token': customer.csrf, 'content-type': 'application/json' }, body: JSON.stringify({ body: official.message }), signal: AbortSignal.timeout(45000) });
    assert.equal(response.status, 200);
    const reader = response.body!.getReader(); let wire = '';
    while (!wire.includes(': keep-alive')) { const chunk = await reader.read(); assert(!chunk.done); wire += new TextDecoder().decode(chunk.value); }
    const elapsedMs = Date.now() - started; assert(elapsedMs >= 14000);
    await gate.query('COMMIT');
    while (true) { const chunk = await reader.read(); if (chunk.done) break; wire += new TextDecoder().decode(chunk.value); }
    noInternal(wire); assert.equal(events(wire).at(-1)?.event, 'done');
    record({ check: 'real_heartbeat_comment', configuredDefaultMs: 15000, observedElapsedMs: elapsedMs, comment: ': keep-alive', parserIgnoresComment: true });
  } finally { await gate.query('ROLLBACK'); gate.release(); }

  if (options.sseOnly) {
    const staff = await admin.request(`/t/pixelforge/admin/tickets/${approvalTicket}`);
    assert.equal(staff.status, 200);
    const draft = staff.json.drafts[0]; assert(draft);
    const approved = await admin.request(`/t/pixelforge/admin/tickets/${approvalTicket}/drafts/${draft.id}/approve`, 'POST', { version: draft.version });
    assert.equal(approved.status, 200);
    const detail = await admin.request(`/t/pixelforge/admin/tickets/${approvalTicket}`);
    const message = detail.json.messages.find((message: { draftId: string | null }) => message.draftId === draft.id);
    assert(message); assert.equal(message.visibility, 'public'); assert(message.sources.length > 0);
    const { SourceSchema } = await import('../../contracts/src/index');
    message.sources.forEach((source: unknown) => SourceSchema.parse(source));
    record({ check: 'staff_public_sources_example', messageId: message.id, authorType: message.authorType, visibility: message.visibility, sources: message.sources });
    return { temporaryPassword: '' };
  }

  const email = `task579-${Date.now()}@example.test`;
  const created = await admin.request('/t/pixelforge/admin/agents', 'POST', { name: 'Task579 agent', email });
  assert.equal(created.status, 201); CreateAgentResponseSchema.parse(created.json);
  const agentId = created.json.agent.id, password = created.json.temporaryPassword;
  const agent = new HttpClient(base);
  assert.equal((await agent.request('/t/pixelforge/auth/login', 'POST', { email, password })).status, 200);
  assert.equal((await agent.request('/t/pixelforge/admin/agents', 'POST', { name: 'denied', email: `denied-${email}` })).status, 403);
  const ticket = await admin.request(`/t/pixelforge/admin/tickets/${clickTicket}`);
  assert.equal((await admin.request(`/t/pixelforge/admin/tickets/${clickTicket}`, 'PATCH', { version: ticket.json.version, assigneeId: agentId })).status, 200);
  const list = await admin.request('/t/pixelforge/admin/agents');
  assert(list.json.items.some((entry: { id: string; assignedOpenCount: number; status: string }) => entry.id === agentId && entry.assignedOpenCount === 1 && entry.status === 'active'));
  const { rows: staff } = await pool.query("SELECT u.id,u.role,t.slug FROM users u JOIN tenants t ON t.id=u.tenant_id WHERE u.role IN('tenant_admin','customer','agent')");
  const self = staff.find(row => row.slug === 'pixelforge' && row.role === 'tenant_admin')!;
  const nonAgent = staff.find(row => row.slug === 'pixelforge' && row.role === 'customer')!;
  const foreign = staff.find(row => row.slug === 'mailpulse' && row.role === 'agent')!;
  assert.equal((await admin.request(`/t/pixelforge/admin/agents/${self.id}`, 'PATCH', { status: 'disabled' })).status, 403);
  assert.equal((await admin.request(`/t/pixelforge/admin/agents/${nonAgent.id}`, 'PATCH', { status: 'disabled' })).status, 403);
  assert.equal((await admin.request(`/t/pixelforge/admin/agents/${foreign.id}`, 'PATCH', { status: 'disabled' })).status, 404);
  // Force audit INSERT failure in this test DB only to prove atomic rollback of
  // user state AND session revocation; no app source/test endpoint is changed.
  await pool.query("CREATE FUNCTION task579_audit_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action='agent.disable' THEN RAISE EXCEPTION 'task579_test_audit_failure'; END IF; RETURN NEW; END $$; CREATE TRIGGER task579_audit_failure BEFORE INSERT ON audit_log FOR EACH ROW EXECUTE FUNCTION task579_audit_failure()");
  try {
    assert.equal((await admin.request(`/t/pixelforge/admin/agents/${agentId}`, 'PATCH', { status: 'disabled' })).status, 500);
    assert.equal((await pool.query('SELECT status FROM users WHERE id=$1', [agentId])).rows[0].status, 'active');
    const { rows: sessions } = await pool.query('SELECT revoked_at FROM sessions WHERE user_id=$1', [agentId]);
    assert(sessions.length > 0); assert(sessions.every(session => session.revoked_at === null));
    assert.equal((await pool.query("SELECT count(*)::int AS n FROM audit_log WHERE target_id=$1 AND action='agent.disable'", [agentId])).rows[0].n, 0);
  } finally { await pool.query('DROP TRIGGER task579_audit_failure ON audit_log; DROP FUNCTION task579_audit_failure()'); }
  assert.equal((await admin.request(`/t/pixelforge/admin/agents/${agentId}`, 'PATCH', { status: 'disabled' })).status, 200);
  assert((await pool.query('SELECT revoked_at FROM sessions WHERE user_id=$1', [agentId])).rows.every(row => row.revoked_at !== null));
  assert.equal((await agent.request('/t/pixelforge/admin/tickets')).status, 401);
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM audit_log WHERE target_id=$1 AND action='agent.disable'", [agentId])).rows[0].n, 1);
  const target = await admin.request(`/t/pixelforge/admin/tickets/${approvalTicket}`);
  assert.equal((await admin.request(`/t/pixelforge/admin/tickets/${approvalTicket}`, 'PATCH', { version: target.json.version, assigneeId: agentId })).status, 400);
  const finalList = await admin.request('/t/pixelforge/admin/agents');
  assert(finalList.json.items.some((entry: { id: string; status: string; assignedOpenCount: number }) => entry.id === agentId && entry.status === 'disabled' && entry.assignedOpenCount === 1));
  const auditJson = JSON.stringify((await pool.query('SELECT * FROM audit_log WHERE target_id=$1', [agentId])).rows);
  assert(!auditJson.includes(password)); assert(!auditJson.includes('temporaryPassword')); assert(!finalList.text.includes(password));
  record({ check: 'agents_atomic_security', agentId, rollbackStatus: 500, rollbackUserStatus: 'active', rollbackRevokedSessions: 0, rollbackAuditRows: 0, disabledStatus: 200, priorSessionStatus: 401, auditRows: 1, foreignStatus: 404, selfStatus: 403, nonAgentStatus: 403, agentCreateStatus: 403, newAssignmentStatus: 400, assignedOpenCount: 1, listStatus: 'disabled', passwordLeakCount: 0 });
  return { temporaryPassword: password };
}
