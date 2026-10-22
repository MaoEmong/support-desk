import { describe, expect, it } from 'vitest';
import { DECISION_REASONS, DecisionReasonSchema, type TenantAISettings } from '../src/contracts';
import { createCachedKbRepository } from '../src/kb/cached';
import type { KbArticle, KbRepository } from '../src/kb/search';
import { InMemoryKbRepository } from '../src/kb/search';
import { kbRepositoryContract, runContract, settingsReaderContract } from '../src/testing';

const tenantIds = { a: 'tenant-a', b: 'tenant-b', unknown: 'tenant-zzz' };

describe('kbRepositoryContract', () => {
  const checks = kbRepositoryContract({
    tenantIds,
    setup: async (fx) => {
      // DB 흉내: 게시 문서만 tenant 조건으로 읽는 loader
      const rows = [...fx.published.map((a) => ({ ...a, published: true })), ...fx.unpublished.map((a) => ({ ...a, published: false }))];
      return createCachedKbRepository(async (tenantId) => rows.filter((r) => r.published && r.tenantId === tenantId));
    },
  });
  for (const c of checks) it(c.name, c.run);

  it('격리가 깨진 저장소는 키트가 잡아낸다', async () => {
    let all: KbArticle[] = [];
    const leaky = kbRepositoryContract({
      tenantIds,
      setup: async (fx) => {
        all = [...fx.published, ...fx.unpublished];
        const perTenant = new InMemoryKbRepository(all);
        const repo: KbRepository = {
          async search(q) {
            const own = await perTenant.search(q);
            const other = await perTenant.search({ ...q, tenantId: q.tenantId === tenantIds.a ? tenantIds.b : tenantIds.a });
            return [...own, ...other].slice(0, q.limit);
          },
        };
        return repo;
      },
    });
    const results = await runContract(leaky);
    expect(results.filter((r) => !r.ok).length).toBeGreaterThan(0);
    expect(results.find((r) => r.name.includes('A 문서만'))?.ok).toBe(false);
  });
});

describe('settingsReaderContract', () => {
  const store = new Map<string, TenantAISettings>();
  const checks = settingsReaderContract({
    tenantIds,
    setup: async (fx) => {
      store.set(tenantIds.a, structuredClone(fx.a));
      store.set(tenantIds.b, structuredClone(fx.b));
      return { getTenantAISettings: async (id) => (store.has(id) ? structuredClone(store.get(id)!) : null) };
    },
    updateThreshold: async (id, threshold) => {
      const s = store.get(id);
      if (s) store.set(id, { ...s, threshold });
    },
  });
  for (const c of checks) it(c.name, c.run);

  it('캐시가 있는 reader 는 키트가 잡아낸다', async () => {
    const db = new Map<string, TenantAISettings>();
    const cache = new Map<string, TenantAISettings>();
    const results = await runContract(
      settingsReaderContract({
        tenantIds,
        setup: async (fx) => {
          db.set(tenantIds.a, fx.a);
          db.set(tenantIds.b, fx.b);
          return {
            getTenantAISettings: async (id) => {
              if (!cache.has(id) && db.has(id)) cache.set(id, db.get(id)!);
              return cache.get(id) ?? null;
            },
          };
        },
        updateThreshold: async (id, threshold) => {
          db.set(id, { ...db.get(id)!, threshold });
        },
      }),
    );
    expect(results.find((r) => r.name.includes('캐시 없이'))?.ok).toBe(false);
  });

  it('필드를 잃어버리는 reader 는 키트가 잡아낸다', async () => {
    const results = await runContract(
      settingsReaderContract({
        tenantIds,
        setup: async (fx) => ({
          getTenantAISettings: async (id) => (id === tenantIds.a ? { ...fx.a, categories: fx.a.categories.map((c) => ({ ...c, keywords: [] })) } : null),
        }),
        updateThreshold: async () => undefined,
      }),
    );
    expect(results.find((r) => r.name.includes('테넌트 A'))?.error).toContain('categories');
  });
});

describe('DECISION_REASONS', () => {
  it('스키마 enum 과 같은 목록이다', () => {
    expect([...DECISION_REASONS]).toEqual(DecisionReasonSchema.options);
    expect(new Set(DECISION_REASONS).size).toBe(11);
  });
});
