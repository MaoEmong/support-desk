import { describe, expect, it } from 'vitest';
import { sha256 } from '../auth/crypto';
import { Client, loginAs, makeWorld, PASSWORD } from './helpers';

describe('로그인·세션', () => {
  it('로그인하면 HttpOnly 세션 쿠키와 읽을 수 있는 CSRF 쿠키를 주고, DB에는 토큰 해시만 저장한다', async () => {
    const w = makeWorld();
    const c = new Client(w.app);
    const res = await c.post('/t/game/auth/login', { email: w.users.custA1.email, password: PASSWORD });
    expect(res.status).toBe(200);
    expect(res.json.user).toMatchObject({ id: w.users.custA1.id, role: 'customer' });
    const setCookies = res.headers.getSetCookie();
    expect(setCookies.find((s) => s.startsWith('sd_session='))).toMatch(/HttpOnly/);
    expect(setCookies.find((s) => s.startsWith('sd_csrf='))).not.toMatch(/HttpOnly/);
    const token = c.cookies.get('sd_session')!;
    expect(w.repo.state.sessions.map((s) => s.id)).toEqual([sha256(token)]);
    expect(JSON.stringify(w.repo.state.sessions)).not.toContain(token);
    expect((await c.get('/t/game/auth/me')).json.user.email).toBe(w.users.custA1.email);
  });

  it('틀린 비밀번호·없는 계정은 같은 401 INVALID_CREDENTIALS', async () => {
    const w = makeWorld();
    const c = new Client(w.app);
    const a = await c.post('/t/game/auth/login', { email: w.users.custA1.email, password: 'wrong-password' });
    const b = await c.post('/t/game/auth/login', { email: 'nobody@a.test', password: 'wrong-password' });
    expect([a.status, b.status]).toEqual([401, 401]);
    expect(a.json).toMatchObject({ code: 'INVALID_CREDENTIALS' });
    expect(b.json.code).toBe('INVALID_CREDENTIALS');
    expect(a.json.message).toBe(b.json.message);
  });

  it('A 테넌트 계정으로 B 테넌트에 로그인할 수 없다', async () => {
    const w = makeWorld();
    const res = await new Client(w.app).post('/t/mkt/auth/login', { email: w.users.custA1.email, password: PASSWORD });
    expect(res.status).toBe(401);
  });

  it('A 테넌트 세션으로 B 테넌트 경로를 호출하면 401(세션 영역 불일치)', async () => {
    const w = makeWorld();
    const c = await loginAs(w, 'agentA');
    expect((await c.get('/t/mkt/auth/me')).status).toBe(401);
    expect((await c.get('/t/mkt/admin/tickets')).status).toBe(401);
    expect((await c.get('/t/game/admin/tickets')).status).toBe(200);
  });

  it('없는 테넌트 slug는 404', async () => {
    const w = makeWorld();
    expect((await new Client(w.app).get('/t/nope/settings/public')).status).toBe(404);
  });

  it('미인증 401, 로그아웃 후 같은 쿠키 재사용 불가', async () => {
    const w = makeWorld();
    expect((await new Client(w.app).get('/t/game/tickets')).status).toBe(401);
    const c = await loginAs(w, 'custA1');
    const stolen = c.cookies.get('sd_session')!;
    expect((await c.post('/t/game/auth/logout')).status).toBe(204);
    expect(c.cookies.has('sd_session')).toBe(false);
    const replay = new Client(w.app);
    replay.cookies.set('sd_session', stolen);
    const res = await replay.get('/t/game/auth/me');
    expect(res.status).toBe(401);
  });

  it('유휴 시간이 지나면 SESSION_EXPIRED, 활동 중이어도 절대 만료는 연장되지 않는다', async () => {
    const w = makeWorld({ cfg: { sessionIdleMs: 30 * 60_000, sessionAbsoluteMs: 2 * 3_600_000 } });
    const c = await loginAs(w, 'custA1');
    w.clock.advance(31 * 60_000);
    const idle = await c.get('/t/game/auth/me');
    expect(idle.status).toBe(401);
    expect(idle.json.code).toBe('SESSION_EXPIRED');

    const d = await loginAs(w, 'custA1');
    for (let i = 0; i < 4; i++) {
      w.clock.advance(25 * 60_000); // 계속 활동(유휴 30분 안쪽) — 로그인 후 최대 100분
      expect((await d.get('/t/game/auth/me')).status).toBe(200);
    }
    w.clock.advance(25 * 60_000); // 로그인 후 125분: 유휴는 25분뿐이지만 절대 만료(120분) 초과
    const abs = await d.get('/t/game/auth/me');
    expect(abs.status).toBe(401);
    expect(abs.json.code).toBe('SESSION_EXPIRED');
  });

  it('비활성화된 계정의 기존 세션은 즉시 무효', async () => {
    const w = makeWorld();
    const c = await loginAs(w, 'agentA');
    w.repo.state.users.find((u) => u.id === w.users.agentA.id)!.status = 'disabled';
    expect((await c.get('/t/game/auth/me')).status).toBe(401);
  });

  it('로그인 실패가 한도를 넘으면 맞는 비밀번호도 429', async () => {
    const w = makeWorld({ cfg: { loginMaxFailuresPerAccount: 3 } });
    const c = new Client(w.app);
    for (let i = 0; i < 3; i++) {
      expect((await c.post('/t/game/auth/login', { email: w.users.custA1.email, password: 'bad-pass' })).status).toBe(401);
    }
    const blocked = await c.post('/t/game/auth/login', { email: w.users.custA1.email, password: PASSWORD });
    expect(blocked.status).toBe(429);
    expect(blocked.json.code).toBe('TOO_MANY_ATTEMPTS');
    expect(blocked.headers.get('retry-after')).toBeTruthy();
    // 다른 테넌트의 같은 이메일 키에는 영향 없음 + 창이 지나면 다시 허용
    w.clock.advance(w.cfg.loginWindowMs + 1);
    expect((await c.post('/t/game/auth/login', { email: w.users.custA1.email, password: PASSWORD })).status).toBe(200);
  });

  it('IP 기준 제한: 여러 계정을 돌려도 같은 IP는 막힌다', async () => {
    const w = makeWorld({ cfg: { loginMaxFailuresPerIp: 4, loginMaxFailuresPerAccount: 100 } });
    const c = new Client(w.app);
    const ip = { 'x-forwarded-for': '203.0.113.7' };
    for (let i = 0; i < 4; i++) await c.post('/t/game/auth/login', { email: `x${i}@a.test`, password: 'bad-pass' }, ip);
    expect((await c.post('/t/game/auth/login', { email: w.users.custA1.email, password: PASSWORD }, ip)).status).toBe(429);
    expect((await c.post('/t/game/auth/login', { email: w.users.custA1.email, password: PASSWORD }, { 'x-forwarded-for': '198.51.100.1' })).status).toBe(200);
  });

  it('로그인 시 기존 세션은 폐기된다(세션 고정 방지)', async () => {
    const w = makeWorld();
    const c = await loginAs(w, 'custA1');
    const first = c.cookies.get('sd_session')!;
    await c.post('/t/game/auth/login', { email: w.users.custA1.email, password: PASSWORD });
    expect(c.cookies.get('sd_session')).not.toBe(first);
    const old = new Client(w.app);
    old.cookies.set('sd_session', first);
    expect((await old.get('/t/game/auth/me')).status).toBe(401);
  });
});

describe('회원가입', () => {
  it('테넌트별 고객으로 가입되고 바로 로그인 상태가 된다', async () => {
    const w = makeWorld();
    const c = new Client(w.app);
    const res = await c.post('/t/game/auth/signup', { email: 'New@A.test', password: 'longenough1', name: '신규' });
    expect(res.status).toBe(201);
    expect(res.json.user).toMatchObject({ email: 'new@a.test', role: 'customer', tenantId: w.tenantA.id });
    expect((await c.get('/t/game/tickets')).status).toBe(200);
    // 같은 이메일로 B 테넌트에는 별도 가입 가능(계정은 테넌트별)
    expect((await new Client(w.app).post('/t/mkt/auth/signup', { email: 'new@a.test', password: 'longenough1', name: '신규' })).status).toBe(201);
  });

  it('같은 테넌트 중복 이메일은 409, role 주입은 400', async () => {
    const w = makeWorld();
    const dup = await new Client(w.app).post('/t/game/auth/signup', { email: w.users.custA1.email, password: 'longenough1', name: 'x' });
    expect(dup.status).toBe(409);
    expect(dup.json.code).toBe('EMAIL_TAKEN');
    const inj = await new Client(w.app).post('/t/game/auth/signup', { email: 'evil@a.test', password: 'longenough1', name: 'x', role: 'tenant_admin' });
    expect(inj.status).toBe(400);
    expect(w.repo.state.users.some((u) => u.email === 'evil@a.test')).toBe(false);
  });

  it('짧은 비밀번호는 400 VALIDATION_FAILED', async () => {
    const w = makeWorld();
    const res = await new Client(w.app).post('/t/game/auth/signup', { email: 'a@a.test', password: 'short', name: 'x' });
    expect(res.status).toBe(400);
    expect(res.json).toMatchObject({ code: 'VALIDATION_FAILED' });
    expect(Array.isArray(res.json.details)).toBe(true);
  });
});

describe('CSRF', () => {
  it('인증된 변경 요청에 CSRF 헤더가 없거나 틀리면 403', async () => {
    const w = makeWorld();
    const c = await loginAs(w, 'custA1');
    const none = await c.post('/t/game/tickets', { title: 't', body: 'b' }, { 'x-csrf-token': '' });
    expect(none.status).toBe(403);
    expect(none.json.code).toBe('CSRF_FAILED');
    const wrong = await c.post('/t/game/tickets', { title: 't', body: 'b' }, { 'x-csrf-token': 'forged' });
    expect(wrong.status).toBe(403);
    expect(w.repo.state.tickets).toHaveLength(0);
    expect((await c.post('/t/game/tickets', { title: 't', body: 'b' })).status).toBe(201);
  });

  it('다른 사이트 Origin의 변경 요청은 토큰이 맞아도 403', async () => {
    const w = makeWorld();
    const c = await loginAs(w, 'custA1');
    const res = await c.post('/t/game/tickets', { title: 't', body: 'b' }, { origin: 'https://evil.example' });
    expect(res.status).toBe(403);
    expect(res.json.details).toMatchObject({ reason: 'origin_mismatch' });
  });

  it('로그인 CSRF: form 인코딩 요청은 415, 외부 Origin은 403', async () => {
    const w = makeWorld();
    const c = new Client(w.app);
    const form = await c.req('POST', '/t/game/auth/login', `email=${w.users.custA1.email}&password=${PASSWORD}`, {
      'content-type': 'application/x-www-form-urlencoded',
    });
    expect(form.status).toBe(415);
    const cross = await c.post('/t/game/auth/login', { email: w.users.custA1.email, password: PASSWORD }, { origin: 'https://evil.example' });
    expect(cross.status).toBe(403);
    expect(c.cookies.has('sd_session')).toBe(false);
  });

  it('다른 세션의 CSRF 토큰으로는 통과할 수 없다', async () => {
    const w = makeWorld();
    const a = await loginAs(w, 'custA1');
    const b = await loginAs(w, 'custA2');
    const res = await a.post('/t/game/tickets', { title: 't', body: 'b' }, { 'x-csrf-token': b.csrf! });
    expect(res.status).toBe(403);
  });

  it('조회(GET)는 CSRF 헤더 없이 가능', async () => {
    const w = makeWorld();
    const c = await loginAs(w, 'custA1');
    expect((await c.get('/t/game/tickets', { 'x-csrf-token': '' })).status).toBe(200);
  });
});
