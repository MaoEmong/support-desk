import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { loginAs, makeWorld, type World } from './helpers';

async function ticketOf(w: World, who: 'custA1' | 'custA2' | 'custB1', title = '결제했는데 아이템 미지급') {
  const c = await loginAs(w, who);
  const slug = who === 'custB1' ? 'mkt' : 'game';
  const res = await c.post(`/t/${slug}/tickets`, { title, body: `${title} 본문` });
  expect(res.status).toBe(201);
  return { c, id: res.json.id as string };
}

describe('고객 간 격리(IDOR)', () => {
  it('다른 고객의 티켓 상세·댓글·해결확인은 모두 404, 목록에도 안 보인다', async () => {
    const w = makeWorld();
    const { id } = await ticketOf(w, 'custA1');
    const other = await loginAs(w, 'custA2');
    expect((await other.get(`/t/game/tickets/${id}`)).status).toBe(404);
    expect((await other.post(`/t/game/tickets/${id}/messages`, { body: '끼어들기' })).status).toBe(404);
    expect((await other.post(`/t/game/tickets/${id}/resolve`)).status).toBe(404);
    const list = await other.get('/t/game/tickets');
    expect(list.json.items).toHaveLength(0);
    expect(list.json.total).toBe(0);
    // 시도해도 아무것도 바뀌지 않음
    expect(w.repo.state.ticketMessages.filter((m) => m.ticketId === id)).toHaveLength(1);
    expect(w.repo.state.tickets[0]!.status).toBe('open');
  });

  it('존재하지 않는 id·잘못된 형식 id도 같은 404', async () => {
    const w = makeWorld();
    const c = await loginAs(w, 'custA1');
    expect((await c.get(`/t/game/tickets/${randomUUID()}`)).status).toBe(404);
    expect((await c.get('/t/game/tickets/not-a-uuid')).status).toBe(404);
    expect((await c.get("/t/game/tickets/1' or '1'='1")).status).toBe(404);
  });
});

describe('테넌트 간 격리', () => {
  it('B 테넌트 상담원·관리자는 자기 slug로 A 티켓 id를 넣어도 404', async () => {
    const w = makeWorld();
    const { id } = await ticketOf(w, 'custA1');
    for (const who of ['agentB', 'adminB'] as const) {
      const c = await loginAs(w, who);
      expect((await c.get(`/t/mkt/admin/tickets/${id}`)).status).toBe(404);
      expect((await c.post(`/t/mkt/admin/tickets/${id}/replies`, { body: 'x' })).status).toBe(404);
      expect((await c.post(`/t/mkt/admin/tickets/${id}/notes`, { body: 'x' })).status).toBe(404);
      expect((await c.patch(`/t/mkt/admin/tickets/${id}`, { version: 1, status: 'closed' })).status).toBe(404);
      expect((await c.post(`/t/mkt/admin/tickets/${id}/drafts/regenerate`)).status).toBe(404);
      const queue = await c.get('/t/mkt/admin/tickets');
      expect(queue.json.items.map((t: { id: string }) => t.id)).not.toContain(id);
    }
    expect(w.repo.state.ticketMessages.filter((m) => m.ticketId === id)).toHaveLength(1);
  });

  it('B 고객은 A 티켓을 볼 수 없다(자기 slug 경유)', async () => {
    const w = makeWorld();
    const { id } = await ticketOf(w, 'custA1');
    const b = await loginAs(w, 'custB1');
    expect((await b.get(`/t/mkt/tickets/${id}`)).status).toBe(404);
  });

  it('다른 테넌트 사용자에게 배정할 수 없다', async () => {
    const w = makeWorld();
    const { id } = await ticketOf(w, 'custA1');
    const agent = await loginAs(w, 'agentA');
    const res = await agent.patch(`/t/game/admin/tickets/${id}`, { version: 1, assigneeId: w.users.agentB.id });
    expect(res.status).toBe(400);
    expect(w.repo.state.tickets[0]!.assigneeId).toBeNull();
    // 같은 테넌트의 고객에게도 배정 불가
    expect((await agent.patch(`/t/game/admin/tickets/${id}`, { version: 1, assigneeId: w.users.custA2.id })).status).toBe(400);
  });

  it('KB도 테넌트 안에서만 보이고 수정된다', async () => {
    const w = makeWorld();
    const adminA = await loginAs(w, 'adminA');
    const created = await adminA.post('/t/game/admin/kb', { title: '설치 사양', body: '최소 사양은…', category: 'install', tags: ['pc'] });
    expect(created.status).toBe(201);
    const adminB = await loginAs(w, 'adminB');
    expect((await adminB.get(`/t/mkt/admin/kb/${created.json.id}`)).status).toBe(404);
    expect((await adminB.patch(`/t/mkt/admin/kb/${created.json.id}`, { title: 'hacked' })).status).toBe(404);
    expect((await adminB.del(`/t/mkt/admin/kb/${created.json.id}`)).status).toBe(404);
    expect((await adminB.get('/t/mkt/admin/kb')).json.items).toHaveLength(0);
    expect(w.repo.state.kb[0]!.title).toBe('설치 사양');
  });
});

describe('역할 정책', () => {
  it('고객은 상담원/관리자 API에 403', async () => {
    const w = makeWorld();
    const c = await loginAs(w, 'custA1');
    for (const p of ['/t/game/admin/tickets', '/t/game/admin/settings', '/t/game/admin/kb', '/t/game/admin/metrics', '/t/game/admin/agents']) {
      const res = await c.get(p);
      expect(res.status, p).toBe(403);
      expect(res.json.code).toBe('FORBIDDEN');
    }
  });

  it('상담원은 큐·KB 조회는 가능, 설정·KB 수정은 403', async () => {
    const w = makeWorld();
    const c = await loginAs(w, 'agentA');
    expect((await c.get('/t/game/admin/tickets')).status).toBe(200);
    expect((await c.get('/t/game/admin/kb')).status).toBe(200);
    expect((await c.get('/t/game/admin/settings')).status).toBe(403);
    expect((await c.patch('/t/game/admin/settings', { approvalMode: true })).status).toBe(403);
    expect((await c.post('/t/game/admin/kb', { title: 'x', body: 'y' })).status).toBe(403);
  });

  it('상담원·관리자는 고객 전용 API(문의 작성·챗봇)를 쓸 수 없다', async () => {
    const w = makeWorld();
    const c = await loginAs(w, 'agentA');
    expect((await c.post('/t/game/tickets', { title: 't', body: 'b' })).status).toBe(403);
    expect((await c.post('/t/game/chat', { body: 'hi' })).status).toBe(403);
  });

  it('tenant_admin은 설정을 바꿀 수 있고 공개 설정에 반영된다', async () => {
    const w = makeWorld();
    const c = await loginAs(w, 'adminA');
    const res = await c.patch('/t/game/admin/settings', { chatbotName: '픽셀봇', aiThreshold: 0.9, approvalMode: true, forbiddenCategories: ['refund'] });
    expect(res.status).toBe(200);
    expect(res.json).toMatchObject({ chatbotName: '픽셀봇', aiThreshold: 0.9, approvalMode: true });
    const pub = await c.get('/t/game/settings/public');
    expect(pub.json).toMatchObject({ chatbotName: '픽셀봇', approvalMode: true, aiMode: 'mock' });
    expect(pub.json).not.toHaveProperty('aiSystemPrompt');
    expect(pub.json).not.toHaveProperty('forbiddenCategories');
    // B 테넌트 설정은 그대로
    expect((await c.get('/t/mkt/settings/public')).json.chatbotName).toBe('마케팅랩 봇');
    // 범위 밖 값·알 수 없는 필드는 400
    expect((await c.patch('/t/game/admin/settings', { aiThreshold: 2 })).status).toBe(400);
    expect((await c.patch('/t/game/admin/settings', { tenantId: w.tenantB.id })).status).toBe(400);
  });

  it('설정 PATCH는 공유 strict 스키마: version·autoAnswerLimit은 400, 정상 patch는 last-write-wins + 감사 기록', async () => {
    const w = makeWorld();
    const c = await loginAs(w, 'adminA');
    for (const bad of [{ version: 1, chatbotName: 'x' }, { autoAnswerLimit: 1 }, { autoAnswerLimit: 2 }, { logoUrl: 'javascript:alert(1)' }, { logoUrl: 'http://evil.example/a.png' }, { logoUrl: '//evil.example/a.png' }]) {
      const res = await c.patch('/t/game/admin/settings', bad);
      expect(res.status, JSON.stringify(bad)).toBe(400);
      expect(res.json.code).toBe('VALIDATION_FAILED');
    }
    const before = w.repo.state.settings.find((s) => s.tenantId === w.tenantA.id)!;
    expect(before.chatbotName).not.toBe('x');
    const ok = await c.patch('/t/game/admin/settings', { aiThreshold: 0.8, logoUrl: 'https://cdn.example/logo.png' });
    expect(ok.status).toBe(200);
    expect(ok.json).toMatchObject({ aiThreshold: 0.8, logoUrl: 'https://cdn.example/logo.png', autoAnswerLimit: 1 });
    const again = await c.patch('/t/game/admin/settings', { aiThreshold: 0.75 });
    expect(again.json.aiThreshold).toBe(0.75);
    expect(w.repo.state.audit.filter((a) => a.action === 'settings.update')).toHaveLength(2);
  });
});

describe('플랫폼 관리자', () => {
  it('집계만 볼 수 있고 티켓 본문·AI 원문 API에는 접근할 수 없다', async () => {
    const w = makeWorld();
    const { id } = await ticketOf(w, 'custA1', '비밀스러운 환불 사유');
    const p = await loginAs(w, 'platform');
    const tenants = await p.get('/platform/tenants');
    expect(tenants.status).toBe(200);
    expect(tenants.json.items.map((t: { slug: string }) => t.slug).sort()).toEqual(['game', 'mkt']);
    const metrics = await p.get('/platform/metrics');
    expect(metrics.status).toBe(200);
    expect(metrics.json.ticketsTotal).toBe(1);
    expect(tenants.text + metrics.text).not.toContain('비밀스러운');
    // 테넌트 영역 API는 플랫폼 세션으로 401(별도 세션 영역)
    expect((await p.get(`/t/game/admin/tickets/${id}`)).status).toBe(401);
    expect((await p.get('/t/game/admin/tickets')).status).toBe(401);
    expect((await p.get(`/t/game/tickets/${id}`)).status).toBe(401);
  });

  it('플랫폼 관리자는 테넌트 로그인으로 들어올 수 없고, 테넌트 계정은 플랫폼 로그인 불가', async () => {
    const w = makeWorld();
    const { Client, PASSWORD } = await import('./helpers');
    const c = new Client(w.app);
    expect((await c.post('/t/game/auth/login', { email: w.users.platform.email, password: PASSWORD })).status).toBe(401);
    expect((await c.post('/platform/auth/login', { email: w.users.adminA.email, password: PASSWORD })).status).toBe(401);
  });

  it('테넌트 관리자 세션으로 플랫폼 API는 401', async () => {
    const w = makeWorld();
    const c = await loginAs(w, 'adminA');
    expect((await c.get('/platform/tenants')).status).toBe(401);
    expect((await c.get('/platform/metrics')).status).toBe(401);
  });
});
