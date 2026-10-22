import { describe, expect, it } from 'vitest';
import { Client, loginAs, makeWorld } from './helpers';

describe('상담원 관리 API', () => {
  it('tenant_admin이 상담원을 만들면 role agent·세션 테넌트로 고정되고 임시 비밀번호는 응답에 한 번만 나온다', async () => {
    const w = makeWorld();
    const admin = await loginAs(w, 'adminA');
    const res = await admin.post('/t/game/admin/agents', { name: '새 상담원', email: 'New.Agent@A.test' });
    expect(res.status).toBe(201);
    expect(Object.keys(res.json).sort()).toEqual(['agent', 'temporaryPassword']);
    expect(Object.keys(res.json.agent).sort()).toEqual(['email', 'id', 'name', 'role', 'status']);
    expect(res.json.agent).toMatchObject({ email: 'new.agent@a.test', role: 'agent', status: 'active' });
    const pw = res.json.temporaryPassword as string;
    expect(pw.length).toBeGreaterThanOrEqual(12);
    const row = w.repo.state.users.find((u) => u.email === 'new.agent@a.test')!;
    expect(row).toMatchObject({ tenantId: w.tenantA.id, role: 'agent' });
    // 저장·감사 기록 어디에도 평문 비밀번호가 없다
    expect(row.passwordHash).not.toBe(pw);
    expect(JSON.stringify(w.repo.state)).not.toContain(pw);
    expect(w.repo.state.audit.some((a) => a.action === 'agent.create' && a.targetId === row.id)).toBe(true);
    // 목록·조회 응답에도 다시 나오지 않는다
    expect((await admin.get('/t/game/admin/agents')).text).not.toContain(pw);
    // 임시 비밀번호로 로그인 가능
    const c = new Client(w.app);
    expect((await c.post('/t/game/auth/login', { email: 'new.agent@a.test', password: pw })).status).toBe(200);
  });

  it('같은 테넌트 중복 이메일은 409 EMAIL_TAKEN, role·tenantId·password 주입은 400', async () => {
    const w = makeWorld();
    const admin = await loginAs(w, 'adminA');
    const dup = await admin.post('/t/game/admin/agents', { name: 'x', email: w.users.custA1.email });
    expect(dup.status).toBe(409);
    expect(dup.json.code).toBe('EMAIL_TAKEN');
    for (const extra of [{ role: 'tenant_admin' }, { tenantId: w.tenantB.id }, { password: 'chosen-by-client' }]) {
      const res = await admin.post('/t/game/admin/agents', { name: 'x', email: 'inj@a.test', ...extra });
      expect(res.status).toBe(400);
    }
    expect(w.repo.state.users.some((u) => u.email === 'inj@a.test')).toBe(false);
  });

  it('agent·customer는 생성·비활성화 403, agent는 목록(배정 후보)만 읽는다', async () => {
    const w = makeWorld();
    const agent = await loginAs(w, 'agentA');
    expect((await agent.post('/t/game/admin/agents', { name: 'x', email: 'x@a.test' })).status).toBe(403);
    expect((await agent.patch(`/t/game/admin/agents/${w.users.agentA.id}`, { status: 'disabled' })).status).toBe(403);
    expect((await agent.get('/t/game/admin/agents')).status).toBe(200);
    const cust = await loginAs(w, 'custA1');
    expect((await cust.get('/t/game/admin/agents')).status).toBe(403);
  });

  it('비활성화: 상태 변경·기존 세션 폐기·감사 기록이 함께 일어나고 이후 로그인 불가', async () => {
    const w = makeWorld();
    const agent = await loginAs(w, 'agentA');
    const admin = await loginAs(w, 'adminA');
    const res = await admin.patch(`/t/game/admin/agents/${w.users.agentA.id}`, { status: 'disabled' });
    expect(res.status).toBe(200);
    expect(res.json.agent.status).toBe('disabled');
    expect(res.json.revokedSessions).toBe(1);
    expect(w.repo.state.sessions.filter((s) => s.userId === w.users.agentA.id).every((s) => s.revokedAt)).toBe(true);
    expect(w.repo.state.audit.some((a) => a.action === 'agent.disable' && a.targetId === w.users.agentA.id)).toBe(true);
    const old = await agent.get('/t/game/admin/tickets');
    expect(old.status).toBe(401);
    expect(old.json.code).toBe('SESSION_EXPIRED');
    expect((await new Client(w.app).post('/t/game/auth/login', { email: w.users.agentA.email, password: 'password1234' })).status).toBe(401);
    // 다시 요청해도 멱등
    expect((await admin.patch(`/t/game/admin/agents/${w.users.agentA.id}`, { status: 'disabled' })).status).toBe(200);
  });

  it('자기 자신·agent 아닌 대상 거부, 다른 테넌트 상담원 404, 재활성화 요청은 400', async () => {
    const w = makeWorld();
    const admin = await loginAs(w, 'adminA');
    const self = await admin.patch(`/t/game/admin/agents/${w.users.adminA.id}`, { status: 'disabled' });
    expect(self.status).toBe(403);
    expect(self.json.details).toMatchObject({ reason: 'self' });
    const cust = await admin.patch(`/t/game/admin/agents/${w.users.custA1.id}`, { status: 'disabled' });
    expect(cust.status).toBe(403);
    expect(cust.json.details).toMatchObject({ reason: 'not_agent' });
    expect((await admin.patch(`/t/game/admin/agents/${w.users.agentB.id}`, { status: 'disabled' })).status).toBe(404);
    expect(w.repo.state.users.find((u) => u.id === w.users.agentB.id)!.status).toBe('active');
    expect((await admin.patch(`/t/game/admin/agents/${w.users.agentA.id}`, { status: 'active' })).status).toBe(400);
  });

  it('목록에 status와 열린 티켓 담당 수가 있고, 비활성 상담원에게는 새로 배정할 수 없다', async () => {
    const w = makeWorld();
    const cust = await loginAs(w, 'custA1');
    const t1 = (await cust.post('/t/game/tickets', { title: 'a', body: 'a' })).json;
    const t2 = (await cust.post('/t/game/tickets', { title: 'b', body: 'b' })).json;
    const admin = await loginAs(w, 'adminA');
    expect((await admin.patch(`/t/game/admin/tickets/${t1.id}`, { version: 1, assigneeId: w.users.agentA.id })).status).toBe(200);
    const list = (await admin.get('/t/game/admin/agents')).json.items;
    expect(list.find((a: { id: string }) => a.id === w.users.agentA.id)).toMatchObject({ status: 'active', assignedOpenCount: 1 });
    expect(list.some((a: { id: string }) => a.id === w.users.agentB.id)).toBe(false);

    await admin.patch(`/t/game/admin/agents/${w.users.agentA.id}`, { status: 'disabled' });
    const after = (await admin.get('/t/game/admin/agents')).json.items;
    expect(after.find((a: { id: string }) => a.id === w.users.agentA.id).status).toBe('disabled');
    const assign = await admin.patch(`/t/game/admin/tickets/${t2.id}`, { version: 1, assigneeId: w.users.agentA.id });
    expect(assign.status).toBe(400);
    expect(assign.json.code).toBe('VALIDATION_FAILED');
  });
});
