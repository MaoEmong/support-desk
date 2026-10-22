/**
 * @support/ai/testing 적합성 키트(KB 8 + Settings 5)를 실제 PostgreSQL DB 구현으로 실행하고,
 * web·worker처럼 서로 다른 KB 캐시 인스턴스가 kbRevision으로 함께 갱신되는지 확인한다.
 * 실행(기반팀 단독, 마이그레이션된 "버려도 되는" DB):
 *   TEST_DATABASE_URL=postgresql://…/support_desk_it pnpm vitest run apps/web/src/server/__tests__/ai-contract.integration.test.ts
 * TEST_DATABASE_URL이 없으면 전체 skip. 매 실행 무작위 테넌트를 만들고 지우지 않는다.
 */
import { randomUUID } from 'node:crypto';
import { tenantSettingsToRow } from '@support/ai';
import { kbRepositoryContract, settingsReaderContract, type ContractTenantIds } from '@support/ai/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Repo } from '../repo/types';

const url = process.env.TEST_DATABASE_URL;

describe.skipIf(!url)('AI 적합성 키트 — DB 구현', () => {
  let mod: typeof import('@support/db');
  let deps: typeof import('../ai/deps');
  let repo: Repo;
  const run = randomUUID().slice(0, 8);

  const newIds = (): ContractTenantIds => ({ a: randomUUID(), b: randomUUID(), unknown: randomUUID() });

  /** 키트는 검사 목록을 만들 때 tenantIds를 바로 읽으므로 id는 미리 만들고, 행은 setup(첫 검사 직전)에서 넣는다 */
  async function makeTenants(
    prefix: string,
    settings?: { a: Parameters<typeof tenantSettingsToRow>[0]; b: Parameters<typeof tenantSettingsToRow>[0] },
    ids: ContractTenantIds = newIds(),
  ) {
    const { db, schema } = mod;
    await db.insert(schema.tenants).values([
      { id: ids.a, slug: `${prefix}-a-${run}`, name: `${prefix}A` },
      { id: ids.b, slug: `${prefix}-b-${run}`, name: `${prefix}B` },
    ]);
    await db.insert(schema.tenantSettings).values([
      { tenantId: ids.a, displayName: `${prefix}A`, ...(settings ? tenantSettingsToRow(settings.a) : { chatbotName: 'A', fallbackCategory: 'other' }) },
      { tenantId: ids.b, displayName: `${prefix}B`, ...(settings ? tenantSettingsToRow(settings.b) : { chatbotName: 'B', fallbackCategory: 'other' }) },
    ]);
    return ids;
  }

  beforeAll(async () => {
    process.env.DATABASE_URL = url;
    mod = await import('@support/db');
    deps = await import('../ai/deps');
    const { DrizzleRepo } = await import('../repo/drizzle');
    repo = new DrizzleRepo(mod.db);
  });

  afterAll(async () => {
    await mod?.pool.end();
  });

  // ---- KB 8: 공개 문서만·테넌트 조건 로더 + createCachedKbRepository(getRevision = tenant_settings.kbRevision) ----
  describe('KbRepository(createKbRepository)', () => {
    const ids = newIds();
    const checks = kbRepositoryContract({
      tenantIds: ids,
      setup: async (fx) => {
        await makeTenants('kb', undefined, ids);
        const now = new Date();
        for (const a of [...fx.published.map((x) => ({ ...x, published: true })), ...fx.unpublished.map((x) => ({ ...x, published: false }))]) {
          // 서버 KB 생성 경로(같은 tx에서 kbRevision +1). id는 DB uuid로 새로 정한다(키트는 제목으로 식별)
          await repo.createKb(
            { id: randomUUID(), tenantId: a.tenantId, title: a.title, question: a.question, body: a.body, category: a.category, tags: a.tags, published: a.published },
            now,
          );
        }
        return deps.createKbRepository(mod.db);
      },
    });
    for (const c of checks) it(c.name, c.run);
  });

  // ---- Settings 5: 캐시 없음, parseTenantSettingsRow 경유 ----
  describe('SettingsReader(createSettingsReader)', () => {
    const ids = newIds();
    const checks = settingsReaderContract({
      tenantIds: ids,
      setup: async (fx) => {
        await makeTenants('st', fx, ids);
        return deps.createSettingsReader(mod.db);
      },
      // 관리자 PATCH와 같은 저장소 경로
      updateThreshold: async (tenantId, threshold) => {
        await repo.updateSettings(tenantId, { aiThreshold: threshold }, new Date());
      },
    });
    for (const c of checks) it(c.name, c.run);
  });

  // ---- web·worker 별도 캐시 인스턴스가 kbRevision으로 함께 갱신 ----
  it('KB 생성·수정·비공개·삭제가 kbRevision을 올리고, 서로 다른 캐시 인스턴스 둘 다 다음 검색에서 반영한다', async () => {
    const ids = await makeTenants('rev');
    const web = deps.createKbRepository(mod.db, { ttlMs: Infinity });
    const worker = deps.createKbRepository(mod.db, { ttlMs: Infinity });
    const q = { tenantId: ids.a, query: '무지개 고래 이벤트 보상', limit: 5 };
    const titles = async (r: typeof web) => (await r.search(q)).map((h) => h.article.title);

    // 새 테넌트는 0에서 시작
    expect(await deps.getKbRevision(mod.db, ids.a)).toBe(0);
    expect(await titles(web)).toEqual([]);
    expect(await titles(worker)).toEqual([]);

    const a = await repo.createKb(
      { id: randomUUID(), tenantId: ids.a, title: '무지개 고래 이벤트 보상', question: '', body: '무지개 고래 이벤트 보상은 우편함으로 지급됩니다.', category: null, tags: [], published: true },
      new Date(),
    );
    expect(await deps.getKbRevision(mod.db, ids.a)).toBe(1);
    expect(await titles(web)).toEqual(['무지개 고래 이벤트 보상']);
    expect(await titles(worker)).toEqual(['무지개 고래 이벤트 보상']);

    await repo.updateKb(ids.a, a.id, { title: '무지개 고래 이벤트 보상 안내' }, new Date());
    expect(await titles(web)).toEqual(['무지개 고래 이벤트 보상 안내']);
    expect(await titles(worker)).toEqual(['무지개 고래 이벤트 보상 안내']);

    await repo.updateKb(ids.a, a.id, { published: false }, new Date());
    expect(await titles(worker)).toEqual([]);
    await repo.updateKb(ids.a, a.id, { published: true }, new Date());
    expect(await titles(worker)).toHaveLength(1);

    expect(await repo.deleteKb(ids.a, a.id)).toBe(true);
    expect(await titles(web)).toEqual([]);
    expect(await titles(worker)).toEqual([]);
    expect(await deps.getKbRevision(mod.db, ids.a)).toBe(5) // 생성·수정·비공개·재공개·삭제;
    // 다른 테넌트 revision은 그대로
    expect(await deps.getKbRevision(mod.db, ids.b)).toBe(0);
  });

  it('KB 변경이 롤백되면 kbRevision도 그대로(같은 트랜잭션)', async () => {
    const ids = await makeTenants('rb');
    const before = await deps.getKbRevision(mod.db, ids.a);
    await expect(
      repo.tx(async (tx) => {
        await tx.createKb({ id: randomUUID(), tenantId: ids.a, title: '롤백 문서', question: '', body: '본문', category: null, tags: [], published: true }, new Date());
        throw new Error('rollback');
      }),
    ).rejects.toThrow('rollback');
    expect(await deps.getKbRevision(mod.db, ids.a)).toBe(before);
  });
});
