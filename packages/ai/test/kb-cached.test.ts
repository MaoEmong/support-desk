import { describe, expect, it } from 'vitest';
import { createCachedKbRepository } from '../src/kb/cached';
import { TenantMismatchError, type KbArticle } from '../src/kb/search';

const article = (id: string, tenantId: string, title: string): KbArticle => ({
  id,
  tenantId,
  title,
  question: title,
  body: `${title} 안내 본문`,
  category: 'install',
  tags: [],
});

function fakeDb() {
  const rows: KbArticle[] = [article('a1', 'A', '설치 사양 안내'), article('b1', 'B', '설치 사양 안내 B')];
  const revisions = new Map<string, number>([
    ['A', 1],
    ['B', 1],
  ]);
  let loads = 0;
  return {
    rows,
    revisions,
    loads: () => loads,
    loader: async (tenantId: string) => {
      loads++;
      return rows.filter((r) => r.tenantId === tenantId);
    },
    getRevision: async (tenantId: string) => revisions.get(tenantId) ?? null,
  };
}

describe('createCachedKbRepository', () => {
  it('테넌트별로 한 번만 읽고 캐시한다', async () => {
    const db = fakeDb();
    const repo = createCachedKbRepository(db.loader);
    await repo.search({ tenantId: 'A', query: '설치 사양', limit: 3 });
    await repo.search({ tenantId: 'A', query: '설치', limit: 3 });
    expect(db.loads()).toBe(1);
    const b = await repo.search({ tenantId: 'B', query: '설치 사양', limit: 3 });
    expect(db.loads()).toBe(2);
    expect(b.every((h) => h.article.tenantId === 'B')).toBe(true);
  });

  it('동시에 들어온 첫 검색은 로드를 한 번만 한다', async () => {
    const db = fakeDb();
    const repo = createCachedKbRepository(db.loader);
    await Promise.all([1, 2, 3].map(() => repo.search({ tenantId: 'A', query: '설치', limit: 1 })));
    expect(db.loads()).toBe(1);
  });

  it('revision 이 바뀌면 다른 프로세스의 변경도 다시 읽는다', async () => {
    const db = fakeDb();
    const repo = createCachedKbRepository(db.loader, { getRevision: db.getRevision });
    expect(await repo.search({ tenantId: 'A', query: '환불 규정', limit: 3 })).toEqual([]);
    db.rows.push(article('a2', 'A', '환불 규정 안내'));
    expect(await repo.search({ tenantId: 'A', query: '환불 규정', limit: 3 })).toEqual([]); // revision 그대로 → 캐시
    db.revisions.set('A', 2);
    const hits = await repo.search({ tenantId: 'A', query: '환불 규정', limit: 3 });
    expect(hits[0]?.article.id).toBe('a2');
    expect(db.loads()).toBe(2);
  });

  it('invalidate(tenantId) 는 해당 테넌트만 비운다', async () => {
    const db = fakeDb();
    const repo = createCachedKbRepository(db.loader);
    await repo.search({ tenantId: 'A', query: '설치', limit: 1 });
    await repo.search({ tenantId: 'B', query: '설치', limit: 1 });
    repo.invalidate('A');
    await repo.search({ tenantId: 'A', query: '설치', limit: 1 });
    await repo.search({ tenantId: 'B', query: '설치', limit: 1 });
    expect(db.loads()).toBe(3);
    repo.invalidate();
    await repo.search({ tenantId: 'B', query: '설치', limit: 1 });
    expect(db.loads()).toBe(4);
  });

  it('TTL 이 지나면 다시 읽는다', async () => {
    const db = fakeDb();
    let t = 0;
    const repo = createCachedKbRepository(db.loader, { ttlMs: 1000, now: () => t });
    await repo.search({ tenantId: 'A', query: '설치', limit: 1 });
    t = 999;
    await repo.search({ tenantId: 'A', query: '설치', limit: 1 });
    expect(db.loads()).toBe(1);
    t = 1000;
    await repo.search({ tenantId: 'A', query: '설치', limit: 1 });
    expect(db.loads()).toBe(2);
  });

  it('loader 가 다른 테넌트 문서를 섞으면 거부하고 캐시하지 않는다', async () => {
    const db = fakeDb();
    let leaky = true;
    const repo = createCachedKbRepository(async (tenantId) => (leaky ? db.rows : db.rows.filter((r) => r.tenantId === tenantId)));
    await expect(repo.search({ tenantId: 'A', query: '설치', limit: 3 })).rejects.toBeInstanceOf(TenantMismatchError);
    leaky = false;
    const hits = await repo.search({ tenantId: 'A', query: '설치', limit: 3 });
    expect(hits.every((h) => h.article.tenantId === 'A')).toBe(true);
  });

  it('tenantId 없이 검색할 수 없다', async () => {
    const repo = createCachedKbRepository(fakeDb().loader);
    await expect(repo.search({ tenantId: '', query: '설치', limit: 1 })).rejects.toThrow();
  });

  it('invalidate 이전에 시작된 로드 결과는 캐시에 남지 않는다', async () => {
    const db = fakeDb();
    let resolveSlow: (() => void) | undefined;
    let first = true;
    const repo = createCachedKbRepository(async (tenantId) => {
      if (first) {
        first = false;
        await new Promise<void>((r) => (resolveSlow = r));
      }
      return db.loader(tenantId);
    });
    const slow = repo.search({ tenantId: 'A', query: '설치', limit: 1 });
    await Promise.resolve();
    repo.invalidate('A');
    resolveSlow?.();
    await slow;
    await repo.search({ tenantId: 'A', query: '설치', limit: 1 });
    expect(db.loads()).toBe(2);
  });
});
