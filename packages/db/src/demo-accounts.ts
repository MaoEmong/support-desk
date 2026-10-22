/**
 * 데모 계정 표(@support/contracts DEMO_ACCOUNTS)와 seed·일회성 전환의 공용 로직.
 * - 계정은 id가 아니라 (테넌트, 이메일, 역할)로 식별한다. 실제 시연 DB의 기존 행은 seedId 도입 전에 만들어져 id가 다르다.
 * - 전환은 표의 9개 계정만 대상으로, 이전 이메일 행만 새 이메일로 바꾼다. 일반 계정은 건드리지 않는다.
 * - 비밀번호 평문은 반환·로그하지 않는다.
 */
import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import { hash } from 'bcryptjs';
// @support/db는 contracts에 의존하지 않으므로(새 의존성·lock 변경 금지) 의존성 없는 표 모듈을 소스 경로로 읽는다.
import { DEMO_ACCOUNTS, type DemoAccount } from '../../contracts/src/demo-accounts';
import { sessions, tenants, users, type Database } from './index';

export const DEFAULT_DEMO_PASSWORD = 'demo1234';
/** SEED_PASSWORD가 있으면 우선, 없으면 demo1234 */
export const demoPassword = (env: Record<string, string | undefined> = process.env) => env.SEED_PASSWORD || DEFAULT_DEMO_PASSWORD;

type Tx = Parameters<Parameters<Database['transaction']>[0]>[0];
type Exec = Database | Tx;

export interface DemoAccountPlan extends DemoAccount {
  /** 전환 전 이메일 */
  legacyEmail: string;
  /** 새로 만들 때 쓰는 결정적 id 키(seedId) */
  seedKey: string;
}

const TENANT_LOCALS = [
  ['customer1', 'customer'],
  ['customer2', 'customer'],
  ['agent', 'agent'],
  ['admin', 'tenant_admin'],
] as const;

/** 표 순서(테넌트별 고객1·고객2·상담원·관리자, 플랫폼 관리자)와 이전 계정을 1:1로 맞춘다. 표가 이 순서를 벗어나면 즉시 실패 */
export function demoAccountPlans(accounts: readonly DemoAccount[] = DEMO_ACCOUNTS): DemoAccountPlan[] {
  const plans: DemoAccountPlan[] = [];
  const slugs = [...new Set(accounts.filter((a) => a.tenantSlug !== null).map((a) => a.tenantSlug!))];
  for (const slug of slugs) {
    const own = accounts.filter((a) => a.tenantSlug === slug);
    if (own.length !== TENANT_LOCALS.length) throw new Error(`demo accounts: ${slug} must have 4 accounts`);
    own.forEach((a, i) => {
      const [local, role] = TENANT_LOCALS[i]!;
      if (a.role !== role) throw new Error(`demo accounts: ${slug}[${i}] must be ${role}`);
      plans.push({ ...a, legacyEmail: `${local}@${slug}.example.com`, seedKey: `user:${slug}:${local}` });
    });
  }
  const platform = accounts.filter((a) => a.tenantSlug === null);
  if (platform.length !== 1 || platform[0]!.role !== 'platform_admin') throw new Error('demo accounts: exactly one platform_admin');
  plans.push({ ...platform[0]!, legacyEmail: 'platform@support.example.com', seedKey: 'user:platform' });
  if (plans.length !== 9 || new Set(plans.map((p) => `${p.tenantSlug}:${p.email.toLowerCase()}`)).size !== 9) throw new Error('demo accounts: 9 unique accounts required');
  return plans;
}

export interface DemoUserRow {
  id: string;
  email: string;
  role: string;
  tenantId: string | null;
}

/** 테넌트(플랫폼은 null) 안에서 새·이전 이메일 중 하나를 가진 행(대소문자 무시) */
export async function findDemoRows(ex: Exec, tenantId: string | null, plan: DemoAccountPlan): Promise<DemoUserRow[]> {
  const emails = [plan.email.toLowerCase(), plan.legacyEmail.toLowerCase()];
  return ex
    .select({ id: users.id, email: users.email, role: users.role, tenantId: users.tenantId })
    .from(users)
    .where(and(tenantId === null ? isNull(users.tenantId) : eq(users.tenantId, tenantId), inArray(sql`lower(${users.email})`, emails)));
}

export async function tenantIdBySlug(ex: Exec, slug: string): Promise<string | null> {
  const [t] = await ex.select({ id: tenants.id }).from(tenants).where(eq(tenants.slug, slug));
  return t?.id ?? null;
}

export type DemoRowState = 'pending' | 'converted';

export interface DemoConversionReport {
  /** 이번에 이메일·비밀번호를 바꾼 계정 수 */
  converted: number;
  /** 이미 새 이메일이라 건너뛴 계정 수(비밀번호 유지) */
  alreadyConverted: number;
  /** 폐기한 세션 수(이번에 바꾼 계정의 살아 있는 세션) */
  revokedSessions: number;
  accounts: { email: string; legacyEmail: string; role: DemoAccount['role']; tenantSlug: string | null; userId: string; state: DemoRowState }[];
}

export class DemoConversionError extends Error {
  constructor(readonly problems: string[]) {
    super(`demo account conversion refused: ${problems.join('; ')}`);
    this.name = 'DemoConversionError';
  }
}

/** 9개 계정을 식별·검증만 한다(쓰기 없음). 문제가 있으면 DemoConversionError */
export async function planDemoConversion(ex: Exec, plans = demoAccountPlans()): Promise<DemoConversionReport['accounts']> {
  const problems: string[] = [];
  const out: DemoConversionReport['accounts'] = [];
  for (const plan of plans) {
    const tenantId = plan.tenantSlug === null ? null : await tenantIdBySlug(ex, plan.tenantSlug);
    if (plan.tenantSlug !== null && !tenantId) {
      problems.push(`${plan.tenantSlug}: tenant missing`);
      continue;
    }
    const rows = await findDemoRows(ex, tenantId, plan);
    const legacy = rows.filter((r) => r.email.toLowerCase() === plan.legacyEmail.toLowerCase());
    const current = rows.filter((r) => r.email.toLowerCase() === plan.email.toLowerCase());
    if (legacy.length && current.length) {
      problems.push(`${plan.email}: both legacy ${plan.legacyEmail} and new email exist (email conflict)`);
      continue;
    }
    const row = legacy[0] ?? current[0];
    if (!row || rows.length !== 1) {
      problems.push(`${plan.legacyEmail}: expected exactly 1 demo user, found ${rows.length}`);
      continue;
    }
    if (row.role !== plan.role) {
      problems.push(`${row.email}: role ${row.role} != ${plan.role}`);
      continue;
    }
    out.push({ email: plan.email, legacyEmail: plan.legacyEmail, role: plan.role, tenantSlug: plan.tenantSlug, userId: row.id, state: legacy.length ? 'pending' : 'converted' });
  }
  if (out.length !== plans.length && problems.length === 0) problems.push(`identified ${out.length}/${plans.length}`);
  if (problems.length) throw new DemoConversionError(problems);
  return out;
}

/**
 * 일회성 전환(한 트랜잭션): 9개 식별·검증 → 이전 이메일 행만 새 이메일 + 새 비밀번호 해시 → 그 계정의 살아 있는 세션 폐기.
 * 하나라도 불일치면 아무것도 바꾸지 않는다(rollback). 이미 새 이메일인 행은 건너뛴다(비밀번호·세션 유지 → 재실행 안전).
 * id·티켓·메시지·KB·설정은 건드리지 않는다.
 */
export async function convertDemoAccounts(db: Database, opts: { password: string; now?: Date; rounds?: number }): Promise<DemoConversionReport> {
  const now = opts.now ?? new Date();
  const passwordHash = await hash(opts.password, opts.rounds ?? 12);
  return db.transaction(async (tx) => {
    const accounts = await planDemoConversion(tx);
    const pending = accounts.filter((a) => a.state === 'pending');
    for (const a of pending) {
      const updated = await tx
        .update(users)
        .set({ email: a.email, passwordHash, updatedAt: now })
        .where(and(eq(users.id, a.userId), sql`lower(${users.email}) = ${a.legacyEmail.toLowerCase()}`, eq(users.role, a.role)))
        .returning({ id: users.id });
      if (updated.length !== 1) throw new DemoConversionError([`${a.legacyEmail}: changed during conversion`]);
    }
    const revoked = pending.length
      ? await tx
          .update(sessions)
          .set({ revokedAt: now })
          .where(and(inArray(sessions.userId, pending.map((a) => a.userId)), isNull(sessions.revokedAt)))
          .returning({ id: sessions.id })
      : [];
    // 커밋 전 사후 검증: 9개 모두 새 이메일로 식별되어야 한다
    const after = await planDemoConversion(tx);
    if (after.some((a) => a.state !== 'converted')) throw new DemoConversionError(['post-check: not all accounts converted']);
    return { converted: pending.length, alreadyConverted: accounts.length - pending.length, revokedSessions: revoked.length, accounts };
  });
}
