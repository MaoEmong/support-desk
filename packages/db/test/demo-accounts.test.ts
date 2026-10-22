/**
 * 데모 계정 표·일회성 전환·seed 보존 검사(실제 PostgreSQL, 소유 전용 DB).
 * 실행: DEMO_ACCOUNTS_TEST_DATABASE_URL=postgresql://support:support@localhost:55432/support_desk_demoacct_test pnpm vitest run packages/db/test/demo-accounts.test.ts
 * 안전장치: 연결된 DB 이름이 _demoacct_test로 끝나지 않으면 데이터를 지우는 준비 단계를 거부한다. 공유 support_desk·support_desk_e2e는 쓰지 않는다.
 */
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import bcrypt from 'bcryptjs';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { DEMO_ACCOUNTS } from '../../contracts/src/demo-accounts';

const url = process.env.DEMO_ACCOUNTS_TEST_DATABASE_URL;
const LEGACY_PASSWORD = 'legacy-password-1';

describe('DEMO_ACCOUNTS 표(순수 데이터)', () => {
  it('9개, 테넌트별 고객2·상담원·관리자 + 플랫폼 관리자, 비밀번호 필드 없음', () => {
    expect(DEMO_ACCOUNTS).toHaveLength(9);
    for (const a of DEMO_ACCOUNTS) expect(Object.keys(a).sort()).toEqual(['email', 'label', 'role', 'tenantSlug']);
    expect(JSON.stringify(DEMO_ACCOUNTS)).not.toMatch(/password|demo1234/i);
    expect(DEMO_ACCOUNTS.filter((a) => a.tenantSlug === null)).toEqual([{ tenantSlug: null, role: 'platform_admin', email: 'admin@platform.test', label: '플랫폼 관리자' }]);
    for (const [slug, domain] of [['pixelforge', 'pf.test'], ['mailpulse', 'mp.test']] as const) {
      expect(DEMO_ACCOUNTS.filter((a) => a.tenantSlug === slug).map((a) => [a.email, a.role])).toEqual([
        [`c1@${domain}`, 'customer'],
        [`c2@${domain}`, 'customer'],
        [`agent@${domain}`, 'agent'],
        [`admin@${domain}`, 'tenant_admin'],
      ]);
    }
  });
});

describe.skipIf(!url)('데모 계정 전환·seed(실제 DB)', () => {
  let mod: typeof import('../src/index');
  let demo: typeof import('../src/demo-accounts');
  const legacyHash = bcrypt.hashSync(LEGACY_PASSWORD, 4);
  const ids = { pf: randomUUID(), mp: randomUUID() };
  const userIds = new Map<string, string>();

  async function q<T = Record<string, unknown>>(text: string, params: unknown[] = []): Promise<T[]> {
    return (await mod.pool.query(text, params)).rows as T[];
  }

  /** 전환 전 상태 재현: 두 테넌트 + 이전 이메일 데모 9명(무작위 id) + 일반 고객 + 작성 데이터 + 살아 있는 세션 */
  async function legacyWorld() {
    const [{ name }] = await q<{ name: string }>('select current_database() as name');
    if (!name.endsWith('_demoacct_test')) throw new Error(`refusing to wipe ${name}`);
    await q('truncate sessions, login_attempts, audit_log, ai_drafts, ai_runs, ticket_messages, ai_jobs, tickets, conversation_messages, conversations, kb_articles, tenant_settings, users, tenants cascade');
    await q(`insert into tenants(id,slug,name) values ($1,'pixelforge','픽셀포지'),($2,'mailpulse','메일펄스')`, [ids.pf, ids.mp]);
    for (const t of [ids.pf, ids.mp]) {
      await q(`insert into tenant_settings(tenant_id, display_name, chatbot_name, fallback_category) values ($1,'d','bot','other')`, [t]);
    }
    userIds.clear();
    for (const plan of demo.demoAccountPlans()) {
      const id = randomUUID();
      userIds.set(plan.email, id);
      const tenantId = plan.tenantSlug === 'pixelforge' ? ids.pf : plan.tenantSlug === 'mailpulse' ? ids.mp : null;
      await q('insert into users(id, tenant_id, email, name, password_hash, role) values ($1,$2,$3,$4,$5,$6)', [id, tenantId, plan.legacyEmail, plan.label, legacyHash, plan.role]);
      await q(`insert into sessions(id, user_id, tenant_id, role, csrf_token, expires_at) values ($1,$2,$3,$4,'csrf', now() + interval '1 day')`, [`s-${id}`, id, tenantId, plan.role]);
    }
    // 데모가 아닌 일반 고객(전환 대상 아님)
    await q(`insert into users(id, tenant_id, email, name, password_hash, role) values ($1,$2,'someone@pixelforge.example.com','일반',$3,'customer')`, [randomUUID(), ids.pf, legacyHash]);
    await q(`insert into sessions(id, user_id, tenant_id, role, csrf_token, expires_at) select 's-regular', id, tenant_id, 'customer', 'csrf', now() + interval '1 day' from users where email='someone@pixelforge.example.com'`);
    // 작성 데이터: 이전 고객1의 티켓·메시지, KB
    const ticketId = randomUUID();
    await q(`insert into tickets(id, tenant_id, customer_id, title, body) values ($1,$2,$3,'기존 문의','본문')`, [ticketId, ids.pf, userIds.get('c1@pf.test')]);
    await q(`insert into ticket_messages(id, tenant_id, ticket_id, author_id, role, author_type, body) values ($1,$2,$3,$4,'customer','customer','본문')`, [randomUUID(), ids.pf, ticketId, userIds.get('c1@pf.test')]);
    await q(`insert into kb_articles(id, tenant_id, slug, title, body) values ($1,$2,'kb-1','KB','본문')`, [randomUUID(), ids.pf]);
    return ticketId;
  }

  const emailsOf = async () => (await q<{ email: string }>('select email from users order by email')).map((r) => r.email);
  const liveSessions = async () => (await q<{ id: string }>('select id from sessions where revoked_at is null order by id')).map((r) => r.id);

  beforeAll(async () => {
    process.env.DATABASE_URL = url;
    mod = await import('../src/index');
    demo = await import('../src/demo-accounts');
    const { runMigrations } = await import('../src/migrations');
    await runMigrations(mod.pool);
  });

  afterAll(async () => {
    await mod?.pool.end();
  });

  beforeEach(async () => {
    await legacyWorld();
  });

  it('전환: 정확히 9개만 새 이메일·새 비밀번호, 대상 세션만 폐기, id·티켓·KB·설정·일반 계정 보존', async () => {
    const before = await q<{ c: number }>('select (select count(*) from tickets)+(select count(*) from ticket_messages)+(select count(*) from kb_articles)+(select count(*) from tenant_settings) as c');
    const report = await demo.convertDemoAccounts(mod.db, { password: 'demo1234', rounds: 4 });
    expect(report).toMatchObject({ converted: 9, alreadyConverted: 0, revokedSessions: 9 });
    const emails = await emailsOf();
    for (const a of DEMO_ACCOUNTS) expect(emails).toContain(a.email);
    expect(emails.filter((e) => e.endsWith('.example.com'))).toEqual(['someone@pixelforge.example.com']);
    // id 보존(행을 새로 만들지 않고 이메일만 바꿈)
    for (const [email, id] of userIds) expect((await q('select id from users where email=$1', [email]))[0]).toEqual({ id });
    const [c1] = await q<{ password_hash: string }>('select password_hash from users where email=$1', ['c1@pf.test']);
    expect(bcrypt.compareSync('demo1234', c1!.password_hash)).toBe(true);
    expect(bcrypt.compareSync(LEGACY_PASSWORD, c1!.password_hash)).toBe(false);
    expect(await liveSessions()).toEqual(['s-regular']);
    const after = await q<{ c: number }>('select (select count(*) from tickets)+(select count(*) from ticket_messages)+(select count(*) from kb_articles)+(select count(*) from tenant_settings) as c');
    expect(after).toEqual(before);
    expect((await q('select customer_id from tickets'))[0]).toEqual({ customer_id: userIds.get('c1@pf.test') });
  });

  it('재실행: 이미 전환된 9개는 건너뛴다(비밀번호·세션 유지, 일반 계정 덮기 없음)', async () => {
    await demo.convertDemoAccounts(mod.db, { password: 'demo1234', rounds: 4 });
    const hashes = await q('select id, password_hash from users order by id');
    await q(`insert into sessions(id, user_id, tenant_id, role, csrf_token, expires_at) values ('s-new', $1, $2, 'customer', 'csrf', now() + interval '1 day')`, [userIds.get('c1@pf.test'), ids.pf]);
    const again = await demo.convertDemoAccounts(mod.db, { password: 'other-password', rounds: 4 });
    expect(again).toMatchObject({ converted: 0, alreadyConverted: 9, revokedSessions: 0 });
    expect(await q('select id, password_hash from users order by id')).toEqual(hashes);
    expect(await liveSessions()).toEqual(['s-new', 's-regular']);
  });

  it('이메일 충돌(새 이메일을 이미 가진 다른 계정)이면 전체 rollback', async () => {
    await q(`insert into users(id, tenant_id, email, name, password_hash, role) values ($1,$2,'agent@mp.test','충돌',$3,'customer')`, [randomUUID(), ids.mp, legacyHash]);
    const emailsBefore = await emailsOf();
    await expect(demo.convertDemoAccounts(mod.db, { password: 'demo1234', rounds: 4 })).rejects.toThrow(/email conflict/);
    expect(await emailsOf()).toEqual(emailsBefore);
    expect(await liveSessions()).toHaveLength(10);
  });

  it.each([
    ['역할 불일치', `update users set role='customer' where email='agent@pixelforge.example.com'`, /role customer != agent/],
    ['계정 누락', `delete from sessions where user_id in (select id from users where email='customer2@mailpulse.example.com'); delete from users where email='customer2@mailpulse.example.com'`, /found 0/],
    ['테넌트 불일치(플랫폼 계정이 테넌트 소속)', `update users set tenant_id=null, role='platform_admin' where email='admin@mailpulse.example.com'`, /found 0/],
  ])('%s → 거부·rollback(아무것도 바뀌지 않음)', async (_name, mutate, error) => {
    for (const stmt of mutate.split(';').map((s) => s.trim()).filter(Boolean)) await q(stmt);
    const emailsBefore = await emailsOf();
    const sessionsBefore = await liveSessions();
    await expect(demo.convertDemoAccounts(mod.db, { password: 'demo1234', rounds: 4 })).rejects.toThrow(error);
    expect(await emailsOf()).toEqual(emailsBefore);
    expect(await liveSessions()).toEqual(sessionsBefore);
  });

  it('비밀번호 선택: SEED_PASSWORD 우선, 없거나 빈 값이면 demo1234', () => {
    expect(demo.demoPassword({ SEED_PASSWORD: 'custom-pass' })).toBe('custom-pass');
    expect(demo.demoPassword({})).toBe('demo1234');
    expect(demo.demoPassword({ SEED_PASSWORD: '' })).toBe('demo1234');
  });

  describe('seed', () => {
    const dbDir = fileURLToPath(new URL('..', import.meta.url));
    const tsx = fileURLToPath(new URL('../node_modules/tsx/dist/cli.mjs', import.meta.url));
    const seed = (env: Record<string, string>) =>
      execFileSync(process.execPath, [tsx, 'src/seed.ts'], { cwd: dbDir, env: { ...process.env, DATABASE_URL: url, ...env }, stdio: 'pipe' });

    async function wipe() {
      await q('truncate sessions, login_attempts, audit_log, ai_drafts, ai_runs, ticket_messages, ai_jobs, tickets, conversation_messages, conversations, kb_articles, tenant_settings, users, tenants cascade');
    }

    it('빈 DB: 표의 9개 이메일로 생성, SEED_PASSWORD 우선. 재시드는 다른 SEED_PASSWORD여도 기존 비밀번호·계정 보존', async () => {
      await wipe();
      seed({ SEED_PASSWORD: 'custom-seed-pass' });
      const rows = await q<{ email: string; password_hash: string }>('select email, password_hash from users order by email');
      expect(rows.map((r) => r.email).sort()).toEqual(DEMO_ACCOUNTS.map((a) => a.email).sort());
      expect(bcrypt.compareSync('custom-seed-pass', rows[0]!.password_hash)).toBe(true);
      seed({ SEED_PASSWORD: 'another-pass' });
      expect(await q('select email, password_hash from users order by email')).toEqual(rows);
    }, 120_000);

    it('빈 DB + SEED_PASSWORD 없음: 기본 demo1234', async () => {
      await wipe();
      seed({ SEED_PASSWORD: '' });
      const [row] = await q<{ password_hash: string }>('select password_hash from users where email=$1', ['admin@platform.test']);
      expect(bcrypt.compareSync('demo1234', row!.password_hash)).toBe(true);
    }, 120_000);

    it('전환 전(이전 이메일) DB에 재시드해도 중복 계정을 만들지 않는다', async () => {
      // beforeEach의 legacyWorld 상태
      seed({ SEED_PASSWORD: 'another-pass' });
      const emails = await emailsOf();
      for (const a of DEMO_ACCOUNTS) expect(emails).not.toContain(a.email);
      expect(emails.filter((e) => e.endsWith('.example.com'))).toHaveLength(10);
    }, 120_000);
  });
});
