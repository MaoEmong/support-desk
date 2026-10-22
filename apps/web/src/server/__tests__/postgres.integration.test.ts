/**
 * 실제 PostgreSQL 통합 테스트(메모리 저장소 통과를 DB 증거로 쓰지 않기 위함).
 * 실행: 마이그레이션된 "버려도 되는" DB를 TEST_DATABASE_URL로 지정
 *   TEST_DATABASE_URL=postgresql://support:support@localhost:5432/support_desk_test pnpm vitest run apps/web/src/server
 * TEST_DATABASE_URL이 없으면 전체 skip. 매 실행마다 무작위 slug 테넌트를 새로 만들고 지우지 않는다.
 */
import { randomUUID } from 'node:crypto';
import bcrypt from 'bcryptjs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { stubChatResponder } from '../ai/chat';
import { createJobQueue, type AiJobQueue } from '../ai/queue';
import { createApp } from '../app';
import type { Repo } from '../repo/types';
import { Client, PASSWORD, parseSse, testConfig } from './helpers';

const url = process.env.TEST_DATABASE_URL;

describe.skipIf(!url)('PostgreSQL 통합(DrizzleRepo)', () => {
  // @support/db는 import 시점의 DATABASE_URL로 풀을 만든다
  let mod: typeof import('@support/db');
  let DrizzleRepo: typeof import('../repo/drizzle').DrizzleRepo;
  let repo: Repo;
  const run = randomUUID().slice(0, 8);
  const slugA = `it-a-${run}`;
  const slugB = `it-b-${run}`;
  const ids = { tA: randomUUID(), tB: randomUUID(), custA1: randomUUID(), custA2: randomUUID(), agentA: randomUUID(), adminA: randomUUID(), agentB: randomUUID() };
  const email = (n: string) => `${n}-${run}@it.test`;

  const app = (queue?: AiJobQueue) =>
    createApp({ repo, cfg: testConfig(), queue: queue ?? createJobQueue({ pipelineVersion: 'v1' }), chat: stubChatResponder, clock: () => new Date() });

  async function login(slug: string, who: string, a = app()) {
    const c = new Client(a);
    const res = await c.post(`/t/${slug}/auth/login`, { email: email(who), password: PASSWORD });
    expect(res.status, res.text).toBe(200);
    return c;
  }

  beforeAll(async () => {
    process.env.DATABASE_URL = url;
    mod = await import('@support/db');
    ({ DrizzleRepo } = await import('../repo/drizzle'));
    repo = new DrizzleRepo(mod.db);
    const { db, schema } = mod;
    const hash = bcrypt.hashSync(PASSWORD, 4);
    await db.insert(schema.tenants).values([
      { id: ids.tA, slug: slugA, name: '통합A' },
      { id: ids.tB, slug: slugB, name: '통합B' },
    ]);
    await db.insert(schema.tenantSettings).values([
      // categories 기본값은 [{id:'other'}] → fallback도 그 안의 id
      { tenantId: ids.tA, displayName: '통합A', chatbotName: 'A봇', fallbackCategory: 'other' },
      { tenantId: ids.tB, displayName: '통합B', chatbotName: 'B봇', fallbackCategory: 'other' },
    ]);
    const u = (id: string, tenantId: string, role: 'customer' | 'agent' | 'tenant_admin', n: string) => ({ id, tenantId, role, email: email(n), name: n, passwordHash: hash });
    await db.insert(schema.users).values([
      u(ids.custA1, ids.tA, 'customer', 'custA1'),
      u(ids.custA2, ids.tA, 'customer', 'custA2'),
      u(ids.agentA, ids.tA, 'agent', 'agentA'),
      u(ids.adminA, ids.tA, 'tenant_admin', 'adminA'),
      u(ids.agentB, ids.tB, 'agent', 'agentB'),
    ]);
  });

  afterAll(async () => {
    await mod?.pool.end();
  });

  it('문의 생성 시 ai_jobs가 같은 트랜잭션으로 저장되고 첫 메시지를 가리킨다', async () => {
    const { db, schema } = mod;
    const { eq } = await import('drizzle-orm');
    const c = await login(slugA, 'custA1');
    const res = await c.post(`/t/${slugA}/tickets`, { title: '통합 문의', body: '본문' });
    expect(res.status, res.text).toBe(201);
    const jobs = await db.select().from(schema.aiJobs).where(eq(schema.aiJobs.ticketId, res.json.id));
    const msgs = await db.select().from(schema.ticketMessages).where(eq(schema.ticketMessages.ticketId, res.json.id));
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({ tenantId: ids.tA, messageId: msgs[0]!.id, kind: 'process_inquiry', status: 'queued' });
    expect(msgs[0]).toMatchObject({ role: 'customer', authorType: 'customer', visibility: 'public' });
  });

  it('작업 등록이 실패하면 티켓·메시지가 롤백된다', async () => {
    const { db, schema } = mod;
    const { eq } = await import('drizzle-orm');
    const failing: AiJobQueue = { ...createJobQueue({ pipelineVersion: 'v1' }), enqueueInquiry: async () => { throw new Error('boom'); } };
    const a = app(failing);
    const c = await login(slugA, 'custA2', a);
    const res = await c.post(`/t/${slugA}/tickets`, { title: '롤백 확인', body: 'x' });
    expect(res.status).toBe(500);
    const rows = await db.select().from(schema.tickets).where(eq(schema.tickets.customerId, ids.custA2));
    expect(rows).toHaveLength(0);
  });

  it('세션은 DB에 해시로 저장되고 로그아웃 후 재사용 불가', async () => {
    const { db, schema } = mod;
    const { eq } = await import('drizzle-orm');
    const c = await login(slugA, 'custA1');
    const token = c.cookies.get('sd_session')!;
    const { sha256 } = await import('../auth/crypto');
    const [row] = await db.select().from(schema.sessions).where(eq(schema.sessions.id, sha256(token)));
    expect(row).toMatchObject({ userId: ids.custA1, tenantId: ids.tA, role: 'customer', revokedAt: null });
    await c.post(`/t/${slugA}/auth/logout`);
    const replay = new Client(app());
    replay.cookies.set('sd_session', token);
    expect((await replay.get(`/t/${slugA}/auth/me`)).status).toBe(401);
  });

  it('다른 고객·다른 테넌트의 티켓 id 직접 접근은 404', async () => {
    const c1 = await login(slugA, 'custA1');
    const { json } = await c1.post(`/t/${slugA}/tickets`, { title: '격리', body: 'x' });
    const c2 = await login(slugA, 'custA2');
    expect((await c2.get(`/t/${slugA}/tickets/${json.id}`)).status).toBe(404);
    const b = await login(slugB, 'agentB');
    expect((await b.get(`/t/${slugB}/admin/tickets/${json.id}`)).status).toBe(404);
    expect((await b.get(`/t/${slugA}/admin/tickets/${json.id}`)).status).toBe(401);
  });

  it('동시 초안 승인: 행 잠금 + version 조건으로 하나만 발송, 하나는 409', async () => {
    const { db, schema } = mod;
    const { eq } = await import('drizzle-orm');
    const cust = await login(slugA, 'custA1');
    const t = (await cust.post(`/t/${slugA}/tickets`, { title: '초안', body: 'x' })).json;
    const [job] = await db.select().from(schema.aiJobs).where(eq(schema.aiJobs.ticketId, t.id));
    const draftId = randomUUID();
    await db.insert(schema.aiDrafts).values({ id: draftId, tenantId: ids.tA, ticketId: t.id, jobId: job!.id, body: 'AI 초안' });
    const a1 = await login(slugA, 'agentA');
    const a2 = await login(slugA, 'adminA');
    const res = await Promise.all([
      a1.post(`/t/${slugA}/admin/tickets/${t.id}/drafts/${draftId}/approve`, { version: 1 }),
      a2.post(`/t/${slugA}/admin/tickets/${t.id}/drafts/${draftId}/approve`, { version: 1 }),
    ]);
    expect(res.map((r) => r.status).sort()).toEqual([200, 409]);
    const sent = await db.select().from(schema.ticketMessages).where(eq(schema.ticketMessages.draftId, draftId));
    expect(sent).toHaveLength(1);
    const [d] = await db.select().from(schema.aiDrafts).where(eq(schema.aiDrafts.id, draftId));
    expect(d).toMatchObject({ status: 'sent', version: 2, sentMessageId: sent[0]!.id, decidedBy: expect.any(String) });
  });

  it('PATCH version 충돌 409(실제 조건부 UPDATE)', async () => {
    const cust = await login(slugA, 'custA1');
    const t = (await cust.post(`/t/${slugA}/tickets`, { title: '버전', body: 'x' })).json;
    const agent = await login(slugA, 'agentA');
    const [r1, r2] = await Promise.all([
      agent.patch(`/t/${slugA}/admin/tickets/${t.id}`, { version: 1, status: 'in_progress' }),
      agent.patch(`/t/${slugA}/admin/tickets/${t.id}`, { version: 1, assigneeId: ids.agentA }),
    ]);
    expect([r1.status, r2.status].sort()).toEqual([200, 409]);
  });

  it('동시 대화 전환에도 티켓 1건(conversation_id UNIQUE + 조건부 상태 전이)', async () => {
    const { db, schema } = mod;
    const { eq } = await import('drizzle-orm');
    const c = await login(slugA, 'custA1');
    const convId = parseSse((await c.post(`/t/${slugA}/chat`, { body: '전환 테스트' })).text).at(-1)!.data.conversationId;
    const res = await Promise.all([1, 2, 3].map(() => c.post(`/t/${slugA}/conversations/${convId}/convert`, { title: '전환' })));
    expect(res.filter((r) => r.status === 201)).toHaveLength(1);
    expect(new Set(res.map((r) => r.json.ticketId)).size).toBe(1);
    const rows = await db.select().from(schema.tickets).where(eq(schema.tickets.conversationId, convId));
    expect(rows).toHaveLength(1);
  });

  it('상담원 생성·비활성화: 해시 저장, 세션 폐기·감사 기록이 같은 트랜잭션, 다른 테넌트 404', async () => {
    const { db, schema } = mod;
    const { and, eq } = await import('drizzle-orm');
    const admin = await login(slugA, 'adminA');
    const created = await admin.post(`/t/${slugA}/admin/agents`, { name: '통합상담원', email: email('newAgent') });
    expect(created.status, created.text).toBe(201);
    const { agent, temporaryPassword } = created.json;
    const [row] = await db.select().from(schema.users).where(eq(schema.users.id, agent.id));
    expect(row).toMatchObject({ tenantId: ids.tA, role: 'agent', status: 'active' });
    expect(row!.passwordHash).not.toContain(temporaryPassword);
    expect((await admin.post(`/t/${slugA}/admin/agents`, { name: 'dup', email: email('newAgent') })).json.code).toBe('EMAIL_TAKEN');

    const c = new Client(app());
    expect((await c.post(`/t/${slugA}/auth/login`, { email: email('newAgent'), password: temporaryPassword })).status).toBe(200);
    const res = await admin.patch(`/t/${slugA}/admin/agents/${agent.id}`, { status: 'disabled' });
    expect(res.status, res.text).toBe(200);
    const live = await db.select().from(schema.sessions).where(eq(schema.sessions.userId, agent.id));
    expect(live.length).toBeGreaterThan(0);
    expect(live.every((s) => s.revokedAt !== null)).toBe(true);
    const audits = await db
      .select()
      .from(schema.auditLog)
      .where(and(eq(schema.auditLog.action, 'agent.disable'), eq(schema.auditLog.targetId, agent.id)));
    expect(audits).toHaveLength(1);
    expect((await c.get(`/t/${slugA}/admin/tickets`)).status).toBe(401);
    expect((await admin.patch(`/t/${slugA}/admin/agents/${ids.agentB}`, { status: 'disabled' })).status).toBe(404);
  });

  it('KPI 집계 SQL이 실행되고 테넌트 범위로 계산된다', async () => {
    const admin = await login(slugA, 'adminA');
    const m = await admin.get(`/t/${slugA}/admin/metrics`);
    expect(m.status, m.text).toBe(200);
    expect(m.json.ticketsTotal).toBeGreaterThan(0);
    const b = await login(slugB, 'agentB');
    expect((await b.get(`/t/${slugB}/admin/metrics`)).json.ticketsTotal).toBe(0);
  });
});
