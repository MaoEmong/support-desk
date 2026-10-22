import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { createJobQueue, type AiJobQueue } from '../ai/queue';
import type { AiDraft } from '../domain';
import { loginAs, makeWorld, type World } from './helpers';

async function newTicket(w: World) {
  const cust = await loginAs(w, 'custA1');
  const res = await cust.post('/t/game/tickets', { title: '접속 끊김', body: '자꾸 튕겨요' });
  expect(res.status).toBe(201);
  return { cust, id: res.json.id as string };
}

function seedDraft(w: World, ticketId: string, body = 'AI 초안 답변'): AiDraft {
  const d: AiDraft = {
    id: randomUUID(),
    tenantId: w.tenantA.id,
    ticketId,
    conversationId: null,
    jobId: w.repo.state.jobs[0]?.id ?? randomUUID(),
    runId: null,
    body,
    sources: [{ kbArticleId: randomUUID(), title: '접속 문제 해결', excerpt: '…', tenantId: w.tenantA.id }],
    status: 'draft',
    version: 1,
    decidedBy: null,
    decidedAt: null,
    rejectReason: null,
    sentMessageId: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
  w.repo.state.drafts.push(d);
  return d;
}

describe('문의 생성과 AI 작업 등록', () => {
  it('문의·첫 메시지·ai_jobs가 함께 저장되고 작업은 그 메시지를 가리킨다', async () => {
    const w = makeWorld();
    const { id } = await newTicket(w);
    const msgs = w.repo.state.ticketMessages.filter((m) => m.ticketId === id);
    expect(msgs).toHaveLength(1);
    expect(w.repo.state.jobs).toHaveLength(1);
    expect(w.repo.state.jobs[0]).toMatchObject({
      tenantId: w.tenantA.id,
      ticketId: id,
      messageId: msgs[0]!.id,
      kind: 'process_inquiry',
      status: 'queued',
      idempotencyKey: `ticket:${id}:message:${msgs[0]!.id}:v1`,
    });
  });

  it('작업 등록이 실패하면 문의도 남지 않는다(같은 트랜잭션)', async () => {
    const failing: AiJobQueue = {
      ...createJobQueue({ pipelineVersion: 'v1' }),
      enqueueInquiry: async () => {
        throw new Error('queue down');
      },
    };
    const w = makeWorld({ queue: failing });
    const cust = await loginAs(w, 'custA1');
    const res = await cust.post('/t/game/tickets', { title: 't', body: 'b' });
    expect(res.status).toBe(500);
    expect(res.json.message).not.toContain('queue down'); // 내부 오류 상세 비노출
    expect(w.repo.state.tickets).toHaveLength(0);
    expect(w.repo.state.ticketMessages).toHaveLength(0);
  });

  it('Idempotency-Key 재시도는 같은 문의를 돌려주고 작업도 하나', async () => {
    const w = makeWorld();
    const cust = await loginAs(w, 'custA1');
    const h = { 'idempotency-key': 'client-req-0001' };
    const [a, b] = await Promise.all([cust.post('/t/game/tickets', { title: 't', body: 'b' }, h), cust.post('/t/game/tickets', { title: 't', body: 'b' }, h)]);
    expect([a.status, b.status].sort()).toEqual([200, 201]);
    expect(a.json.id).toBe(b.json.id);
    expect(w.repo.state.tickets).toHaveLength(1);
    expect(w.repo.state.jobs).toHaveLength(1);
  });

  it('클라이언트가 보낸 tenantId·customerId·status는 무시/거부된다', async () => {
    const w = makeWorld();
    const cust = await loginAs(w, 'custA1');
    const res = await cust.post('/t/game/tickets', { title: 't', body: 'b', tenantId: w.tenantB.id });
    expect(res.status).toBe(400);
    expect(w.repo.state.tickets).toHaveLength(0);
  });
});

describe('고객 DTO 비노출', () => {
  it('내부 메모·미승인 초안·AI 분석·tenantId가 고객 응답에 없다', async () => {
    const w = makeWorld();
    const { cust, id } = await newTicket(w);
    const agent = await loginAs(w, 'agentA');
    expect((await agent.post(`/t/game/admin/tickets/${id}/notes`, { body: '내부메모: 결제 로그 확인 필요' })).status).toBe(201);
    seedDraft(w, id, '미승인초안: 환불해드릴게요');
    w.repo.state.runs.push({
      id: randomUUID(), tenantId: w.tenantA.id, jobId: w.repo.state.jobs[0]!.id, ticketId: id, conversationId: null, messageId: null,
      status: 'succeeded', decision: 'escalate', reason: '금지카테고리', category: 'refund', urgency: 'high', sentiment: 'angry',
      confidence: 0.42, sources: null, model: 'mock', inputTokens: 1, outputTokens: 1, latencyMs: 1, error: null, pipelineVersion: 'v1',
      result: { secret: 'AI내부분석' }, createdAt: new Date(), updatedAt: new Date(),
    });
    Object.assign(w.repo.state.tickets[0]!, { category: 'refund', urgency: 'high', sentiment: 'angry' });

    for (const res of [await cust.get(`/t/game/tickets/${id}`), await cust.get('/t/game/tickets')]) {
      expect(res.status).toBe(200);
      for (const s of ['내부메모', '미승인초안', 'AI내부분석', '금지카테고리', 'refund', 'angry', w.tenantA.id, 'internal']) {
        expect(res.text, s).not.toContain(s);
      }
    }
    const detail = (await cust.get(`/t/game/tickets/${id}`)).json;
    expect(detail.messages).toHaveLength(1);
    expect(detail).not.toHaveProperty('drafts');
    expect(detail).not.toHaveProperty('aiRuns');
    expect(detail).not.toHaveProperty('category');

    // 상담원은 모두 본다
    const staff = (await agent.get(`/t/game/admin/tickets/${id}`)).json;
    expect(staff.messages.map((m: { visibility: string }) => m.visibility)).toEqual(['public', 'internal']);
    expect(staff.drafts).toHaveLength(1);
    expect(staff.aiRuns[0].category).toBe('refund');
  });

  it('상담원 공개 답변은 고객에게 보이고 상태가 "답변 완료"로 표시된다', async () => {
    const w = makeWorld();
    const { cust, id } = await newTicket(w);
    const agent = await loginAs(w, 'agentA');
    await agent.post(`/t/game/admin/tickets/${id}/replies`, { body: '재접속해 보세요' });
    const d = (await cust.get(`/t/game/tickets/${id}`)).json;
    expect(d.customerStatus).toBe('answered');
    expect(d.messages.map((m: { body: string }) => m.body)).toEqual(['자꾸 튕겨요', '재접속해 보세요']);
    expect(d.messages[1]).toMatchObject({ authorType: 'agent', authorName: '상담A' });
  });
});

describe('고객 상태 흐름', () => {
  it('해결 확인 → 재문의 시 open 복귀, 종료된 문의는 댓글 409', async () => {
    const w = makeWorld();
    const { cust, id } = await newTicket(w);
    const r1 = await cust.post(`/t/game/tickets/${id}/resolve`);
    expect(r1.json).toMatchObject({ status: 'resolved', customerStatus: 'resolved' });
    expect(w.repo.state.tickets[0]!.resolvedByCustomer).toBe(true);
    const r2 = await cust.post(`/t/game/tickets/${id}/messages`, { body: '다시 생겼어요' });
    expect(r2.status).toBe(201);
    expect(r2.json.status).toBe('open');
    expect(w.repo.state.tickets[0]!.resolvedByCustomer).toBe(false);

    const agent = await loginAs(w, 'agentA');
    const v = w.repo.state.tickets[0]!.version;
    expect((await agent.patch(`/t/game/admin/tickets/${id}`, { version: v, status: 'closed' })).status).toBe(200);
    const r3 = await cust.post(`/t/game/tickets/${id}/messages`, { body: '?' });
    expect(r3.status).toBe(409);
    expect(r3.json.code).toBe('TICKET_CLOSED');
  });

  it('자동답변을 받은 티켓의 후속 댓글은 AI 재실행 없이 상담원 이관', async () => {
    const w = makeWorld();
    const { cust, id } = await newTicket(w);
    Object.assign(w.repo.state.tickets[0]!, { autoReplyCount: 1, autoAnsweredAt: new Date() });
    const before = w.repo.state.jobs.length;
    await cust.post(`/t/game/tickets/${id}/messages`, { body: '해결 안 됐어요' });
    expect(w.repo.state.jobs.length).toBe(before);
    expect(w.repo.state.tickets[0]).toMatchObject({ escalationReason: 'customer_followup_after_auto_answer' });
    expect(w.repo.state.tickets[0]!.escalatedAt).not.toBeNull();
  });

  it('자동답변 전 후속 댓글은 메시지별 AI 작업을 등록한다', async () => {
    const w = makeWorld();
    const { cust, id } = await newTicket(w);
    await cust.post(`/t/game/tickets/${id}/messages`, { body: '추가 정보' });
    expect(w.repo.state.jobs).toHaveLength(2);
    expect(new Set(w.repo.state.jobs.map((j) => j.messageId)).size).toBe(2);
  });
});

describe('상담원 티켓 변경(PATCH, version 409)', () => {
  it('오래된 version은 409, 허용되지 않는 전이도 409', async () => {
    const w = makeWorld();
    const { id } = await newTicket(w);
    const agent = await loginAs(w, 'agentA');
    const ok = await agent.patch(`/t/game/admin/tickets/${id}`, { version: 1, status: 'in_progress', assigneeId: w.users.agentA.id });
    expect(ok.status).toBe(200);
    expect(ok.json).toMatchObject({ status: 'in_progress', assigneeId: w.users.agentA.id, version: 2 });
    const stale = await agent.patch(`/t/game/admin/tickets/${id}`, { version: 1, status: 'resolved' });
    expect(stale.status).toBe(409);
    expect(stale.json.code).toBe('VERSION_CONFLICT');
    await agent.patch(`/t/game/admin/tickets/${id}`, { version: 2, status: 'closed' });
    const reopen = await agent.patch(`/t/game/admin/tickets/${id}`, { version: 3, status: 'open' });
    expect(reopen.status).toBe(409);
    expect(reopen.json.code).toBe('INVALID_TRANSITION');
  });

  it('큐 필터: 상태·담당자·분류·이관', async () => {
    const w = makeWorld();
    const a = await newTicket(w);
    await newTicket(w);
    Object.assign(w.repo.state.tickets.find((t) => t.id === a.id)!, { category: 'bug', urgency: 'high', escalatedAt: new Date(), assigneeId: w.users.agentA.id });
    const agent = await loginAs(w, 'agentA');
    const ids = async (q: string) => (await agent.get(`/t/game/admin/tickets?${q}`)).json.items.map((t: { id: string }) => t.id);
    expect(await ids('category=bug')).toEqual([a.id]);
    expect(await ids('urgency=high&escalated=true')).toEqual([a.id]);
    expect(await ids('assigneeId=me')).toEqual([a.id]);
    expect((await ids('assigneeId=none')).length).toBe(1);
    expect((await agent.get('/t/game/admin/tickets?status=bogus')).status).toBe(400);
  });
});

describe('AI 초안 승인·수정·반려', () => {
  it('동시 승인: 한쪽만 200, 다른 쪽 409, 고객 메시지는 정확히 1건', async () => {
    const w = makeWorld();
    const { cust, id } = await newTicket(w);
    const d = seedDraft(w, id);
    const a1 = await loginAs(w, 'agentA');
    const a2 = await loginAs(w, 'adminA');
    const res = await Promise.all([
      a1.post(`/t/game/admin/tickets/${id}/drafts/${d.id}/approve`, { version: 1 }),
      a2.post(`/t/game/admin/tickets/${id}/drafts/${d.id}/approve`, { version: 1, body: '수정본' }),
    ]);
    expect(res.map((r) => r.status).sort()).toEqual([200, 409]);
    const loser = res.find((r) => r.status === 409)!;
    expect(loser.json.code).toBe('VERSION_CONFLICT');
    expect(loser.json.details.current.status).toBe('sent');
    const sent = w.repo.state.ticketMessages.filter((m) => m.draftId === d.id);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ visibility: 'public', sourceJobId: d.jobId });
    expect(w.repo.state.drafts[0]).toMatchObject({ status: 'sent', version: 2, sentMessageId: sent[0]!.id });
    const view = (await cust.get(`/t/game/tickets/${id}`)).json;
    expect(view.messages).toHaveLength(2);
    expect(view.messages[1].sources[0].title).toBe('접속 문제 해결');
  });

  it('수정 후 이전 version으로 승인하면 409, 반려된 초안은 승인 불가', async () => {
    const w = makeWorld();
    const { id } = await newTicket(w);
    const d = seedDraft(w, id);
    const agent = await loginAs(w, 'agentA');
    const edit = await agent.patch(`/t/game/admin/tickets/${id}/drafts/${d.id}`, { version: 1, body: '고친 초안' });
    expect(edit.status).toBe(200);
    expect(edit.json.drafts[0]).toMatchObject({ body: '고친 초안', version: 2 });
    expect((await agent.post(`/t/game/admin/tickets/${id}/drafts/${d.id}/approve`, { version: 1 })).status).toBe(409);
    expect((await agent.post(`/t/game/admin/tickets/${id}/drafts/${d.id}/reject`, { version: 2, reason: '부정확' })).status).toBe(200);
    expect((await agent.post(`/t/game/admin/tickets/${id}/drafts/${d.id}/approve`, { version: 3 })).status).toBe(409);
    expect(w.repo.state.ticketMessages.filter((m) => m.draftId === d.id)).toHaveLength(0);
  });

  it('다른 티켓 경로로 초안 id를 넣으면 404', async () => {
    const w = makeWorld();
    const t1 = await newTicket(w);
    const t2 = await newTicket(w);
    const d = seedDraft(w, t1.id);
    const agent = await loginAs(w, 'agentA');
    expect((await agent.post(`/t/game/admin/tickets/${t2.id}/drafts/${d.id}/approve`, { version: 1 })).status).toBe(404);
  });

  it('초안 재생성: 진행 중 작업이 있으면 409 JOB_IN_PROGRESS', async () => {
    const w = makeWorld();
    const { id } = await newTicket(w);
    const agent = await loginAs(w, 'agentA');
    const r1 = await agent.post(`/t/game/admin/tickets/${id}/drafts/regenerate`);
    expect(r1.status).toBe(202);
    const job = w.repo.state.jobs.find((j) => j.id === r1.json.jobId)!;
    expect(job).toMatchObject({ kind: 'regenerate_draft', messageId: null, ticketId: id });
    const r2 = await agent.post(`/t/game/admin/tickets/${id}/drafts/regenerate`);
    expect(r2.status).toBe(409);
    expect(r2.json.code).toBe('JOB_IN_PROGRESS');
  });
});

describe('KPI', () => {
  it('자동해결률은 고객 해결 확인 + 상담원 공개답변 없음 기준', async () => {
    const w = makeWorld();
    const a = await newTicket(w);
    await newTicket(w);
    Object.assign(w.repo.state.tickets.find((t) => t.id === a.id)!, { autoReplyCount: 1, autoAnsweredAt: new Date(), category: 'install' });
    await a.cust.post(`/t/game/tickets/${a.id}/resolve`);
    const admin = await loginAs(w, 'adminA');
    const m = (await admin.get('/t/game/admin/metrics')).json;
    expect(m).toMatchObject({ ticketsTotal: 2, autoResolvedTickets: 1, autoResolutionRate: 0.5, aiMode: 'mock' });
    expect(m.categoryDistribution).toMatchObject({ install: 1, uncategorized: 1 });
  });
});
