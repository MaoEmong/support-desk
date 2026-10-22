/**
 * 어댑터 적합성 키트: 백엔드의 DB 구현(KbRepository·SettingsReader)이 파이프라인 계약을 지키는지 확인한다.
 * 테스트 프레임워크에 묶이지 않도록 "검사 목록"을 돌려준다. vitest 예:
 *
 *   const checks = kbRepositoryContract({ tenantIds, setup: async (fx) => { await seed(fx); return dbKbRepo } });
 *   describe('KB 적합성', () => { for (const c of checks) it(c.name, c.run) });
 *
 * 이 키트는 형식·격리·캐시 동작을 보는 최소 기준이다. 실제 DB 권한·동시성 테스트를 대체하지 않는다.
 */
import type { TenantAISettings, TenantAISettingsInput } from '../contracts';
import { TenantAISettingsSchema } from '../contracts';
import type { KbArticle, KbRepository } from '../kb/search';
import type { SettingsReader } from '../pipeline';

export interface ContractCheck {
  name: string;
  run: () => Promise<void>;
}

export class ContractViolation extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ContractViolation';
  }
}

function check(cond: unknown, message: string): asserts cond {
  if (!cond) throw new ContractViolation(message);
}

/** 테스트 러너 없이 실행할 때: 모든 검사를 돌리고 결과를 모은다. */
export async function runContract(checks: ContractCheck[]): Promise<{ name: string; ok: boolean; error?: string }[]> {
  const results: { name: string; ok: boolean; error?: string }[] = [];
  for (const c of checks) {
    try {
      await c.run();
      results.push({ name: c.name, ok: true });
    } catch (err) {
      results.push({ name: c.name, ok: false, error: err instanceof Error ? err.message : String(err) });
    }
  }
  return results;
}

function once<T>(fn: () => Promise<T>): () => Promise<T> {
  let p: Promise<T> | undefined;
  return () => (p ??= fn());
}

/** 실제 DB 에 존재하는 테넌트 2개(a, b)와 존재하지 않는 테넌트 id 1개 */
export interface ContractTenantIds {
  a: string;
  b: string;
  unknown: string;
}

// ---------------------------------------------------------------------------
// KbRepository
// ---------------------------------------------------------------------------

export interface KbContractFixture {
  /** 게시(published) 상태로 저장할 문서 */
  published: KbArticle[];
  /** 게시되지 않은 상태(초안·보관)로 저장할 문서. 검색에 나오면 안 된다. */
  unpublished: KbArticle[];
}

export interface KbRepositoryContractOptions {
  tenantIds: ContractTenantIds;
  /**
   * fixture 문서를 저장소(DB)에 넣고 검사할 저장소를 돌려준다. 모든 검사가 한 번만 호출한다.
   * 문서 id 는 DB 가 새로 정해도 된다(검사는 제목으로 식별한다). tenantId·title·question·body·category·tags 는 그대로 저장해야 한다.
   */
  setup: (fixture: KbContractFixture) => Promise<KbRepository>;
}

const SHARED_QUERY = '계약검사 공통 안내 문서';
const B_ONLY_QUERY = '보라색 유니콘 정원 축제';
const UNPUBLISHED_QUERY = '비공개 초안 문서 노출 금지';

export function kbContractFixture(tenantIds: ContractTenantIds): KbContractFixture {
  const art = (key: string, tenantId: string, title: string, body: string, category: string): KbArticle => ({
    id: `contract-${key}`,
    tenantId,
    title,
    question: title,
    body,
    category,
    tags: ['contract'],
  });
  return {
    published: [
      art('a-1', tenantIds.a, `[A] ${SHARED_QUERY}`, `${SHARED_QUERY} 테넌트 A 본문입니다.`, 'install'),
      art('a-2', tenantIds.a, '[A] 설치 사양 안내', '권장 사양과 설치 방법을 안내합니다.', 'install'),
      art('a-3', tenantIds.a, '[A] 비밀번호 재설정', '비밀번호를 잊었다면 재설정 메일을 받으세요.', 'account'),
      art('b-1', tenantIds.b, `[B] ${SHARED_QUERY}`, `${SHARED_QUERY} 테넌트 B 본문입니다.`, 'billing'),
      art('b-2', tenantIds.b, `[B] ${B_ONLY_QUERY}`, `${B_ONLY_QUERY} 일정은 테넌트 B 에만 있습니다.`, 'campaign'),
    ],
    unpublished: [art('a-draft', tenantIds.a, `[A] ${UNPUBLISHED_QUERY}`, `${UNPUBLISHED_QUERY} 이 문서는 검색되면 안 됩니다.`, 'install')],
  };
}

export function kbRepositoryContract(options: KbRepositoryContractOptions): ContractCheck[] {
  const { tenantIds } = options;
  const fixture = kbContractFixture(tenantIds);
  const repo = once(() => options.setup(fixture));
  const titlesOf = (tenantId: string) => new Set(fixture.published.filter((a) => a.tenantId === tenantId).map((a) => a.title));

  const onlyOwn = (tenantId: string) => async () => {
    const hits = await (await repo()).search({ tenantId, query: SHARED_QUERY, limit: 10 });
    check(hits.length > 0, `${tenantId}: 공통 질의에 결과가 없습니다(게시 문서 저장·검색 확인)`);
    const own = titlesOf(tenantId);
    for (const h of hits) {
      check(h.article.tenantId === tenantId, `${tenantId}: 다른 테넌트 문서 반환(${h.article.tenantId} / ${h.article.title})`);
      check(own.has(h.article.title), `${tenantId}: fixture 에 없는 문서 반환(${h.article.title})`);
    }
  };

  return [
    { name: 'KB: 테넌트 A 검색은 A 문서만 반환한다', run: onlyOwn(tenantIds.a) },
    { name: 'KB: 테넌트 B 검색은 B 문서만 반환한다', run: onlyOwn(tenantIds.b) },
    {
      name: 'KB: 다른 테넌트 전용 문서는 검색되지 않는다(preferCategory 포함)',
      run: async () => {
        const r = await repo();
        for (const preferCategory of [undefined, 'campaign']) {
          const hits = await r.search({ tenantId: tenantIds.a, query: B_ONLY_QUERY, limit: 10, ...(preferCategory ? { preferCategory } : {}) });
          check(
            hits.every((h) => h.article.tenantId === tenantIds.a && !h.article.title.startsWith('[B]')),
            `A 검색에 B 문서가 섞였습니다(preferCategory=${preferCategory ?? '-'})`,
          );
        }
      },
    },
    {
      name: 'KB: 게시되지 않은 문서는 반환하지 않는다',
      run: async () => {
        const hits = await (await repo()).search({ tenantId: tenantIds.a, query: UNPUBLISHED_QUERY, limit: 10 });
        check(!hits.some((h) => h.article.title.includes(UNPUBLISHED_QUERY)), '비게시 문서가 검색 결과에 있습니다');
      },
    },
    {
      name: 'KB: 존재하지 않는 테넌트는 빈 결과',
      run: async () => {
        const hits = await (await repo()).search({ tenantId: tenantIds.unknown, query: SHARED_QUERY, limit: 10 });
        check(hits.length === 0, `알 수 없는 테넌트에 ${hits.length}건 반환`);
      },
    },
    {
      name: 'KB: tenantId 가 비어 있으면 거부한다',
      run: async () => {
        const r = await repo();
        let rejected = false;
        try {
          await r.search({ tenantId: '', query: SHARED_QUERY, limit: 10 });
        } catch {
          rejected = true;
        }
        check(rejected, 'tenantId 없이 검색이 실행됐습니다');
      },
    },
    {
      name: 'KB: limit 을 지킨다',
      run: async () => {
        const hits = await (await repo()).search({ tenantId: tenantIds.a, query: `${SHARED_QUERY} 설치 사양 비밀번호`, limit: 1 });
        check(hits.length <= 1, `limit=1 인데 ${hits.length}건`);
      },
    },
    {
      name: 'KB: 결과 형식(KbHit)이 계약과 같다',
      run: async () => {
        const hits = await (await repo()).search({ tenantId: tenantIds.a, query: '설치 사양', limit: 5 });
        check(hits.length > 0, '설치 사양 질의에 결과가 없습니다');
        for (const h of hits) {
          check(Number.isFinite(h.score) && h.score >= 0 && h.score <= 1, `score 는 0~1 이어야 합니다(${h.score})`);
          check(Number.isFinite(h.raw) && h.raw >= 0, `raw 는 0 이상 유한수여야 합니다(${h.raw})`);
          const a = h.article;
          check(
            [a.id, a.tenantId, a.title, a.question, a.body, a.category].every((v) => typeof v === 'string') && Array.isArray(a.tags),
            `article 필드 형식 오류(${a.id})`,
          );
          check(a.id.length > 0, 'article.id 가 비어 있습니다');
        }
      },
    },
  ];
}

// ---------------------------------------------------------------------------
// SettingsReader
// ---------------------------------------------------------------------------

export interface SettingsContractFixture {
  a: TenantAISettings;
  b: TenantAISettings;
}

export interface SettingsReaderContractOptions {
  tenantIds: ContractTenantIds;
  /** fixture 설정을 DB 에 저장하고 검사할 reader 를 돌려준다. 모든 검사가 한 번만 호출한다. */
  setup: (fixture: SettingsContractFixture) => Promise<SettingsReader>;
  /** 저장소의 임계값만 바꾼다(관리자 PATCH 와 같은 경로 권장). 캐시 없이 즉시 반영되는지 본다. */
  updateThreshold: (tenantId: string, threshold: number) => Promise<void>;
}

const FIXTURE_A: TenantAISettingsInput = {
  botName: '계약검사 A 도우미',
  systemPrompt: '테넌트 A 지침',
  threshold: 0.7,
  forbiddenCategories: ['refund', 'hacking'],
  approvalMode: false,
  fallbackCategory: 'other',
  allowedLinkDomains: ['help.a.example'],
  autoAnswerLimit: 1,
  categories: [
    { id: 'install', label: '설치', description: '설치 문의', keywords: ['설치', '사양'] },
    { id: 'refund', label: '환불', description: '', keywords: ['환불'] },
    { id: 'hacking', label: '해킹', description: '', keywords: ['해킹', '도용'] },
    { id: 'other', label: '기타', description: '', keywords: [] },
  ],
};

const FIXTURE_B: TenantAISettingsInput = {
  botName: '계약검사 B 서포트',
  systemPrompt: '테넌트 B 지침',
  threshold: 0.55,
  forbiddenCategories: ['account_security'],
  approvalMode: true,
  fallbackCategory: 'etc',
  allowedLinkDomains: ['docs.b.example'],
  autoAnswerLimit: 1,
  categories: [
    { id: 'billing', label: '요금', description: '', keywords: ['요금제'] },
    { id: 'account_security', label: '계정 보안', description: '', keywords: ['비밀번호'] },
    { id: 'etc', label: '기타', description: '', keywords: [] },
  ],
};

export function settingsContractFixture(): SettingsContractFixture {
  return { a: TenantAISettingsSchema.parse(FIXTURE_A), b: TenantAISettingsSchema.parse(FIXTURE_B) };
}

/** 키 순서와 무관한 비교용 직렬화 */
function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  if (v && typeof v === 'object') {
    const entries = Object.entries(v as Record<string, unknown>)
      .filter(([, x]) => x !== undefined)
      .sort(([x], [y]) => (x < y ? -1 : x > y ? 1 : 0));
    return `{${entries.map(([k, x]) => `${JSON.stringify(k)}:${canonical(x)}`).join(',')}}`;
  }
  return JSON.stringify(v);
}

function diffKeys(actual: TenantAISettings, expected: TenantAISettings): string[] {
  return (Object.keys(expected) as (keyof TenantAISettings)[]).filter((k) => canonical(actual[k]) !== canonical(expected[k]));
}

export function settingsReaderContract(options: SettingsReaderContractOptions): ContractCheck[] {
  const { tenantIds } = options;
  const fixture = settingsContractFixture();
  const reader = once(() => options.setup(fixture));

  const roundTrip = (tenantId: string, expected: TenantAISettings) => async () => {
    const got = await (await reader()).getTenantAISettings(tenantId);
    check(got !== null, `${tenantId}: 설정이 null 입니다`);
    const parsed = TenantAISettingsSchema.safeParse(got);
    check(parsed.success, `${tenantId}: 계약 스키마 위반 — ${parsed.success ? '' : parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`);
    const diff = diffKeys(parsed.data, expected);
    check(diff.length === 0, `${tenantId}: 저장한 값과 다른 필드 — ${diff.join(', ')}`);
  };

  return [
    { name: 'Settings: 테넌트 A 설정을 손실 없이 돌려준다(categories 포함)', run: roundTrip(tenantIds.a, fixture.a) },
    { name: 'Settings: 테넌트 B 설정을 손실 없이 돌려준다(A 와 섞이지 않음)', run: roundTrip(tenantIds.b, fixture.b) },
    {
      name: 'Settings: 존재하지 않는 테넌트는 null',
      run: async () => {
        const got = await (await reader()).getTenantAISettings(tenantIds.unknown);
        check(got === null, '알 수 없는 테넌트에 설정을 반환했습니다');
      },
    },
    {
      name: 'Settings: tenantId 가 비어 있으면 null 또는 거부',
      run: async () => {
        let got: TenantAISettings | null = null;
        try {
          got = await (await reader()).getTenantAISettings('');
        } catch {
          return;
        }
        check(got === null, '빈 tenantId 로 설정을 반환했습니다');
      },
    },
    {
      name: 'Settings: 임계값 변경이 캐시 없이 바로 반영된다',
      run: async () => {
        const r = await reader();
        await r.getTenantAISettings(tenantIds.a); // 캐시가 있다면 여기서 채워진다
        await options.updateThreshold(tenantIds.a, 0.91);
        const got = await r.getTenantAISettings(tenantIds.a);
        check(got?.threshold === 0.91, `변경 직후 threshold=${got?.threshold ?? 'null'} (기대 0.91)`);
        const other = await r.getTenantAISettings(tenantIds.b);
        check(other?.threshold === fixture.b.threshold, 'A 의 변경이 B 에 영향을 줬습니다');
      },
    },
  ];
}
