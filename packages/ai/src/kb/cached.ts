/**
 * DB 기반 KB 저장소용 캐시 어댑터.
 * 백엔드는 "테넌트의 게시된 문서 전체를 읽는 loader" 만 구현하면 되고, 검색은 테넌트별 BM25 인메모리 인덱스로 한다.
 *
 * 무효화 3단계(web·worker 가 별도 프로세스라 invalidate() 만으로는 부족하다):
 *   1) getRevision(tenantId): 검색마다 호출해 캐시된 revision 과 다르면 다시 읽는다(프로세스 간 일관성).
 *   2) invalidate(tenantId?): 같은 프로세스에서 KB 를 고친 직후 즉시 비운다.
 *   3) ttlMs: revision 갱신이 누락돼도 최대 이 시간 뒤에는 다시 읽는다(안전망).
 * 테넌트 격리: loader 결과와 검색 결과 모두 tenantId 를 재검증한다. 다른 테넌트 문서가 섞이면 캐시하지 않고 예외.
 */
import type { KbArticle, KbHit, KbRepository, KbSearchQuery } from './search';
import { assertTenantScoped, InMemoryKbRepository, TenantMismatchError } from './search';

export type KbRevision = string | number;

/** 테넌트의 "게시된" KB 문서를 전부 돌려준다. 반드시 tenantId 조건으로 읽어야 한다. */
export type KbLoader = (tenantId: string) => Promise<KbArticle[]>;

export interface CachedKbRepositoryOptions {
  /** 캐시 최대 수명(ms). 기본 300_000(5분). Infinity 면 TTL 만료 없음. */
  ttlMs?: number;
  /** 테넌트 KB 버전(예: tenant_settings.kb_revision). 값이 바뀌면 다시 읽는다. null 이면 TTL 만으로 판단. */
  getRevision?: (tenantId: string) => Promise<KbRevision | null>;
  now?: () => number;
}

export interface CachedKbRepository extends KbRepository {
  /** 지정 테넌트(없으면 전체) 캐시를 비운다. 진행 중이던 로드 결과도 버린다. */
  invalidate(tenantId?: string): void;
}

interface Entry {
  repo: InMemoryKbRepository;
  loadedAt: number;
  revision: KbRevision | null;
}

export const DEFAULT_KB_CACHE_TTL_MS = 300_000;

export function createCachedKbRepository(loader: KbLoader, options: CachedKbRepositoryOptions = {}): CachedKbRepository {
  const ttlMs = options.ttlMs ?? DEFAULT_KB_CACHE_TTL_MS;
  if (!(ttlMs >= 0)) throw new Error('ttlMs 는 0 이상이어야 합니다');
  const now = options.now ?? (() => Date.now());
  const cache = new Map<string, Entry>();
  const inflight = new Map<string, { revision: KbRevision | null; promise: Promise<Entry> }>();
  /** invalidate 이후 끝난 로드가 캐시를 덮어쓰지 않게 하는 세대 번호 */
  const generation = new Map<string, number>();
  let globalGeneration = 0;
  const genOf = (tenantId: string) => `${globalGeneration}:${generation.get(tenantId) ?? 0}`;

  function load(tenantId: string, revision: KbRevision | null): Promise<Entry> {
    const running = inflight.get(tenantId);
    if (running && running.revision === revision) return running.promise;
    const startedGen = genOf(tenantId);
    const promise = (async () => {
      const articles = await loader(tenantId);
      const foreign = articles.filter((a) => a.tenantId !== tenantId).map((a) => a.id);
      if (foreign.length > 0) throw new TenantMismatchError(tenantId, foreign);
      const entry: Entry = { repo: new InMemoryKbRepository(articles), loadedAt: now(), revision };
      if (genOf(tenantId) === startedGen) cache.set(tenantId, entry);
      return entry;
    })();
    inflight.set(tenantId, { revision, promise });
    const clear = () => {
      if (inflight.get(tenantId)?.promise === promise) inflight.delete(tenantId);
    };
    promise.then(clear, clear);
    return promise;
  }

  return {
    async search(query: KbSearchQuery): Promise<KbHit[]> {
      const { tenantId } = query;
      if (!tenantId) throw new Error('tenantId 는 필수입니다');
      const revision = options.getRevision ? await options.getRevision(tenantId) : null;
      let entry = cache.get(tenantId);
      const fresh =
        entry !== undefined && now() - entry.loadedAt < ttlMs && (!options.getRevision || revision === null || entry.revision === revision);
      if (!fresh) entry = await load(tenantId, revision);
      const hits = await entry!.repo.search(query);
      assertTenantScoped(tenantId, hits);
      return hits;
    },
    invalidate(tenantId?: string): void {
      if (tenantId === undefined) {
        globalGeneration++;
        cache.clear();
        inflight.clear();
        return;
      }
      generation.set(tenantId, (generation.get(tenantId) ?? 0) + 1);
      cache.delete(tenantId);
      inflight.delete(tenantId);
    },
  };
}
