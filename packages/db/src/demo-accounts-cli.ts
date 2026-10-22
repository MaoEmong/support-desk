/**
 * pnpm db:demo-accounts — 기존 데모 계정 9개를 공유 표(DEMO_ACCOUNTS) 이메일로 바꾸는 명시적 일회성 스크립트.
 *   기본(dry-run): 대상 DB와 9개 식별 결과만 출력하고 아무것도 바꾸지 않는다.
 *   적용: pnpm db:demo-accounts --apply --expect-db=support_desk
 *     --expect-db 이름이 실제 연결된 current_database()와 같아야 한다(다른 DB 오적용 방지).
 * 데이터 reset 없음. 한 트랜잭션: 불일치(개수·역할·테넌트·이메일 충돌)면 전부 rollback.
 * 새 비밀번호는 SEED_PASSWORD 우선, 없으면 demo1234. 비밀번호 평문은 출력하지 않는다.
 */
import { sql } from 'drizzle-orm';
import { convertDemoAccounts, DemoConversionError, demoPassword, DEFAULT_DEMO_PASSWORD, planDemoConversion } from './demo-accounts';
import { db, pool } from './index';

const args = process.argv.slice(2);
const apply = args.includes('--apply');
const expectDb = args.find((a) => a.startsWith('--expect-db='))?.slice('--expect-db='.length);

/** 비밀번호를 뺀 대상 표시 */
function describeTarget(url: string | undefined): string {
  if (!url) return '(DATABASE_URL 없음)';
  const u = new URL(url);
  return `${u.hostname}:${u.port || '5432'}/${decodeURIComponent(u.pathname.slice(1))}`;
}

const PRESERVED = ['tenants', 'tenant_settings', 'users', 'tickets', 'ticket_messages', 'conversations', 'conversation_messages', 'kb_articles', 'ai_jobs', 'ai_runs', 'ai_drafts', 'audit_log'] as const;

async function snapshot() {
  const counts: Record<string, number> = {};
  for (const t of PRESERVED) {
    const r = await db.execute<{ n: number }>(sql.raw(`select count(*)::int as n from ${t}`));
    counts[t] = r.rows[0]!.n;
  }
  const ids = await db.execute<{ id: string }>(sql`select id from users order by id`);
  const liveSessions = await db.execute<{ n: number }>(sql`select count(*)::int as n from sessions where revoked_at is null`);
  return { counts, userIds: ids.rows.map((r) => r.id), liveSessions: liveSessions.rows[0]!.n };
}

async function main(): Promise<number> {
  if (!process.env.DATABASE_URL) {
    console.error('DATABASE_URL이 필요합니다');
    return 2;
  }
  const current = (await db.execute<{ name: string }>(sql`select current_database() as name`)).rows[0]?.name;
  console.log(`대상: ${describeTarget(process.env.DATABASE_URL)} (current_database=${current})`);
  console.log(`모드: ${apply ? 'APPLY' : 'DRY-RUN(변경 없음)'}`);
  if (apply && expectDb !== current) {
    console.error(`--apply에는 --expect-db=${current} 처럼 연결된 DB 이름을 정확히 지정해야 합니다(받은 값: ${expectDb ?? '없음'})`);
    return 2;
  }
  try {
    if (!apply) {
      const plan = await planDemoConversion(db);
      for (const a of plan) console.log(`  [${a.state}] ${a.tenantSlug ?? 'platform'} ${a.role}: ${a.legacyEmail} → ${a.email} (user ${a.userId})`);
      console.log(`식별 ${plan.length}/9, 전환 대기 ${plan.filter((a) => a.state === 'pending').length}, 이미 전환 ${plan.filter((a) => a.state === 'converted').length}`);
      return 0;
    }
    const before = await snapshot();
    const report = await convertDemoAccounts(db, { password: demoPassword() });
    const after = await snapshot();
    for (const a of report.accounts) console.log(`  [${a.state === 'pending' ? 'converted' : 'already'}] ${a.tenantSlug ?? 'platform'} ${a.role}: ${a.legacyEmail} → ${a.email} (user ${a.userId})`);
    console.log(`비밀번호: ${process.env.SEED_PASSWORD ? 'SEED_PASSWORD(사용자 지정)' : `기본값(${DEFAULT_DEMO_PASSWORD.length}자 기본 데모 비밀번호)`} — 평문 미출력`);
    console.log(`전환 ${report.converted}, 이미 전환 ${report.alreadyConverted}, 폐기 세션 ${report.revokedSessions}`);
    const changed = PRESERVED.filter((t) => before.counts[t] !== after.counts[t]);
    const idsSame = before.userIds.join(',') === after.userIds.join(',');
    console.log(`보존 검사: 테이블 행 수 변화 ${changed.length ? changed.join(',') : '없음'}, 사용자 id 집합 ${idsSame ? '동일' : '변경됨'}, 살아 있는 세션 ${before.liveSessions} → ${after.liveSessions}`);
    console.log(`counts=${JSON.stringify(after.counts)}`);
    return changed.length || !idsSame ? 1 : 0;
  } catch (e) {
    if (e instanceof DemoConversionError) {
      console.error('전환 거부(변경 없음, rollback):');
      for (const p of e.problems) console.error(`  - ${p}`);
      return 1;
    }
    throw e;
  }
}

try {
  process.exitCode = await main();
} finally {
  await pool.end();
}
