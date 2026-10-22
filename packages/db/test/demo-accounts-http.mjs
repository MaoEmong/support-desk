// 데모 계정 전환 후 실제 HTTP 검사(Next dev 서버 대상). 비밀번호 평문은 결과 JSON에 남기지 않는다.
// 사용: BASE_URL=http://127.0.0.1:3300 OUT=docs/verification/demo-accounts/http.json node packages/db/test/demo-accounts-http.mjs
// 기대: 새 이메일 + 데모 비밀번호(SEED_PASSWORD 또는 demo1234) 9개 로그인 성공, 이전 이메일·이전 비밀번호 거부, 역할·테넌트·타 고객 차단.
import { writeFileSync } from 'node:fs';

const BASE = process.env.BASE_URL ?? 'http://127.0.0.1:3300';
const OUT = process.env.OUT;
const NEW_PASSWORD = process.env.SEED_PASSWORD || 'demo1234';
const OLD_PASSWORD = process.env.OLD_PASSWORD ?? 'DemoPassword123!';

const ACCOUNTS = [
  ['pixelforge', 'customer', 'c1@pf.test', 'customer1@pixelforge.example.com'],
  ['pixelforge', 'customer', 'c2@pf.test', 'customer2@pixelforge.example.com'],
  ['pixelforge', 'agent', 'agent@pf.test', 'agent@pixelforge.example.com'],
  ['pixelforge', 'tenant_admin', 'admin@pf.test', 'admin@pixelforge.example.com'],
  ['mailpulse', 'customer', 'c1@mp.test', 'customer1@mailpulse.example.com'],
  ['mailpulse', 'customer', 'c2@mp.test', 'customer2@mailpulse.example.com'],
  ['mailpulse', 'agent', 'agent@mp.test', 'agent@mailpulse.example.com'],
  ['mailpulse', 'tenant_admin', 'admin@mp.test', 'admin@mailpulse.example.com'],
  [null, 'platform_admin', 'admin@platform.test', 'platform@support.example.com'],
];

class Client {
  cookies = new Map();
  async req(method, path, body) {
    const headers = { origin: BASE };
    if (this.cookies.size) headers.cookie = [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; ');
    const csrf = this.cookies.get('sd_csrf') ?? this.cookies.get('sd_pcsrf');
    if (method !== 'GET' && csrf) headers['x-csrf-token'] = decodeURIComponent(csrf);
    if (body !== undefined) headers['content-type'] = 'application/json';
    const res = await fetch(`${BASE}/api${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    for (const c of res.headers.getSetCookie()) {
      const [pair] = c.split(';');
      const i = pair.indexOf('=');
      if (/Max-Age=0/i.test(c)) this.cookies.delete(pair.slice(0, i));
      else this.cookies.set(pair.slice(0, i), pair.slice(i + 1));
    }
    let json = null;
    try {
      json = await res.json();
    } catch {
      /* 본문 없음 */
    }
    return { status: res.status, json };
  }
}

const loginPath = (slug) => (slug ? `/t/${slug}/auth/login` : '/platform/auth/login');
const results = [];
const check = (name, actual, expected) => {
  const ok = actual === expected;
  results.push({ name, expected, actual, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}: ${actual} (기대 ${expected})`);
};

// 0) 공개 설정(최신 schema 동작 확인)
for (const slug of ['pixelforge', 'mailpulse']) check(`공개 설정 ${slug} 200`, (await new Client().req('GET', `/t/${slug}/settings/public`)).status, 200);

const sessions = {};
// 1) 새 이메일 + 데모 비밀번호: 9개 로그인 성공, 역할·테넌트 일치
for (const [slug, role, email] of ACCOUNTS) {
  const c = new Client();
  const r = await c.req('POST', loginPath(slug), { email, password: NEW_PASSWORD });
  check(`로그인 성공 ${email}`, r.status, 200);
  check(`역할 ${email}`, r.json?.user?.role, role);
  sessions[email] = c;
}
// 2) 이전 이메일 + 이전 비밀번호 거부, 3) 새 이메일 + 이전 비밀번호 거부
for (const [slug, , email, legacy] of ACCOUNTS) {
  check(`이전 이메일+이전 비번 거부 ${legacy}`, (await new Client().req('POST', loginPath(slug), { email: legacy, password: OLD_PASSWORD })).status, 401);
  check(`새 이메일+이전 비번 거부 ${email}`, (await new Client().req('POST', loginPath(slug), { email, password: OLD_PASSWORD })).status, 401);
}
// 4) 역할 차단
const pfC1 = sessions['c1@pf.test'];
const pfC2 = sessions['c2@pf.test'];
check('고객 → 상담원 큐 403', (await pfC1.req('GET', '/t/pixelforge/admin/tickets')).status, 403);
check('상담원 → 테넌트 설정 403', (await sessions['agent@pf.test'].req('GET', '/t/pixelforge/admin/settings')).status, 403);
check('상담원 → 상담원 생성 403', (await sessions['agent@pf.test'].req('POST', '/t/pixelforge/admin/agents', { name: 'x', email: 'x@pf.test' })).status, 403);
check('테넌트 관리자 → 설정 200', (await sessions['admin@pf.test'].req('GET', '/t/pixelforge/admin/settings')).status, 200);
check('플랫폼 관리자 → 테넌트 집계 200', (await sessions['admin@platform.test'].req('GET', '/platform/tenants')).status, 200);
check('플랫폼 관리자 → 테넌트 티켓 API 401', (await sessions['admin@platform.test'].req('GET', '/t/pixelforge/admin/tickets')).status, 401);
check('테넌트 관리자 → 플랫폼 API 401', (await sessions['admin@pf.test'].req('GET', '/platform/tenants')).status, 401);
// 5) 타 테넌트·타 고객
check('pf 고객 세션 → mailpulse 경로 401', (await pfC1.req('GET', '/t/mailpulse/tickets')).status, 401);
// 실제 시연 DB에서는 새 문의를 만들지 않고(USE_EXISTING_TICKET=1) seed된 고객1 문의로 격리를 확인한다
let ticketId;
if (process.env.USE_EXISTING_TICKET === '1') {
  const list = await pfC1.req('GET', '/t/pixelforge/tickets');
  check('pf 고객1 문의 목록 200', list.status, 200);
  ticketId = list.json?.items?.[0]?.id;
  check('pf 고객1 기존 문의 있음', typeof ticketId, 'string');
} else {
  const created = await pfC1.req('POST', '/t/pixelforge/tickets', { title: '데모 계정 HTTP 검사', body: '격리 확인용 문의' });
  check('pf 고객1 문의 생성 201', created.status, 201);
  ticketId = created.json?.id;
}
check('pf 고객2 → 고객1 티켓 404', (await pfC2.req('GET', `/t/pixelforge/tickets/${ticketId}`)).status, 404);
check('mp 상담원 → pf 티켓 id(자기 테넌트 경로) 404', (await sessions['agent@mp.test'].req('GET', `/t/mailpulse/admin/tickets/${ticketId}`)).status, 404);
check('mp 고객 → pf 티켓 id(자기 테넌트 경로) 404', (await sessions['c1@mp.test'].req('GET', `/t/mailpulse/tickets/${ticketId}`)).status, 404);
check('pf 상담원 → pf 고객1 티켓 200', (await sessions['agent@pf.test'].req('GET', `/t/pixelforge/admin/tickets/${ticketId}`)).status, 200);

const failed = results.filter((r) => !r.ok).length;
console.log(`합계 ${results.length}, 실패 ${failed}`);
if (OUT) writeFileSync(OUT, JSON.stringify({ base: BASE, at: new Date().toISOString(), total: results.length, failed, results }, null, 2));
process.exit(failed ? 1 : 0);
