/**
 * 테넌트 KB 검색.
 * - KbRepository: 백엔드가 구현해서 주입하는 저장소 인터페이스. tenantId 는 필수이며 저장소는 해당 테넌트 문서만 반환해야 한다.
 * - 파이프라인은 저장소를 믿지 않고 반환 결과의 tenantId 를 다시 검증한다(교차 테넌트 결과가 섞이면 실행을 거부).
 * - 1차 구현은 BM25(한글 음절 bigram). 임베딩 검색은 EmbeddingRetriever 인터페이스만 열어 둔다.
 */
import { tokenize } from '../text';

export interface KbArticle {
  id: string;
  tenantId: string;
  title: string;
  /** 고객 질문 형태의 대표 질문(없으면 빈 문자열) */
  question: string;
  body: string;
  category: string;
  tags: string[];
}

export interface KbHit {
  article: KbArticle;
  /** 0~1 정규화 점수: 질의 중 (말뭉치에 존재하는) 토큰의 IDF 가중 커버리지 */
  score: number;
  /** BM25 원점수(디버깅용) */
  raw: number;
}

export interface KbSearchQuery {
  tenantId: string;
  query: string;
  limit: number;
  /** 카테고리 가중(분류 결과와 같은 카테고리 문서를 살짝 올린다) */
  preferCategory?: string;
}

export interface KbRepository {
  search(query: KbSearchQuery): Promise<KbHit[]>;
}

/** 2차: 임베딩 기반 검색을 붙일 자리. 구현체가 생기면 BM25 결과와 합쳐 순위를 매긴다. */
export interface EmbeddingRetriever {
  embed(texts: string[]): Promise<number[][]>;
  searchByVector(input: { tenantId: string; vector: number[]; limit: number }): Promise<KbHit[]>;
}

export class TenantMismatchError extends Error {
  constructor(
    readonly expectedTenantId: string,
    readonly offending: string[],
  ) {
    super(`KB 결과에 다른 테넌트 문서가 섞여 있습니다: ${offending.join(', ')}`);
    this.name = 'TenantMismatchError';
  }
}

/** 저장소 결과의 소속 테넌트를 재검증한다. 하나라도 다르면 예외(조용히 거르지 않는다 — 격리 버그는 드러나야 한다). */
export function assertTenantScoped(tenantId: string, hits: readonly KbHit[]): void {
  const offending = hits.filter((h) => h.article.tenantId !== tenantId).map((h) => h.article.id);
  if (offending.length > 0) throw new TenantMismatchError(tenantId, offending);
}

// ---------------------------------------------------------------------------
// BM25 인메모리 인덱스 (테스트·평가·소규모 운영용. 운영 DB 저장소도 이 인덱스를 테넌트별로 캐시해 쓸 수 있다.)
// ---------------------------------------------------------------------------

const K1 = 1.2;
const B = 0.75;

interface IndexedDoc {
  article: KbArticle;
  tf: Map<string, number>;
  length: number;
}

class TenantIndex {
  private docs: IndexedDoc[] = [];
  private df = new Map<string, number>();
  private avgLen = 0;

  constructor(articles: KbArticle[]) {
    for (const article of articles) {
      // 제목·대표 질문은 본문보다 중요하므로 두 번 넣어 가중한다.
      const text = [article.title, article.title, article.question, article.question, article.tags.join(' '), article.body].join(' ');
      const tokens = tokenize(text);
      const tf = new Map<string, number>();
      for (const t of tokens) tf.set(t, (tf.get(t) ?? 0) + 1);
      for (const t of tf.keys()) this.df.set(t, (this.df.get(t) ?? 0) + 1);
      this.docs.push({ article, tf, length: tokens.length });
    }
    this.avgLen = this.docs.reduce((s, d) => s + d.length, 0) / Math.max(1, this.docs.length);
  }

  private idf(term: string): number {
    const n = this.docs.length;
    const df = this.df.get(term) ?? 0;
    return Math.log(1 + (n - df + 0.5) / (df + 0.5));
  }

  search(query: string, limit: number, preferCategory?: string): KbHit[] {
    const qTerms = [...new Set(tokenize(query))].filter((t) => this.df.has(t));
    if (qTerms.length === 0 || this.docs.length === 0) return [];
    const totalIdf = qTerms.reduce((s, t) => s + this.idf(t), 0);

    const scored = this.docs.map((doc) => {
      let raw = 0;
      let matchedIdf = 0;
      for (const term of qTerms) {
        const f = doc.tf.get(term) ?? 0;
        if (f === 0) continue;
        const idf = this.idf(term);
        matchedIdf += idf;
        raw += (idf * f * (K1 + 1)) / (f + K1 * (1 - B + (B * doc.length) / this.avgLen));
      }
      let coverage = totalIdf > 0 ? matchedIdf / totalIdf : 0;
      if (preferCategory && doc.article.category === preferCategory && raw > 0) {
        raw *= 1.15;
        coverage = Math.min(1, coverage * 1.1);
      }
      return { article: doc.article, raw, score: coverage };
    });

    return scored
      .filter((h) => h.raw > 0)
      .sort((a, b) => b.raw - a.raw)
      .slice(0, limit);
  }
}

/** 테넌트별로 분리된 인덱스. 검색은 요청한 tenantId 의 인덱스만 본다. */
export class InMemoryKbRepository implements KbRepository {
  private readonly indexes = new Map<string, TenantIndex>();

  constructor(articles: KbArticle[]) {
    const byTenant = new Map<string, KbArticle[]>();
    for (const a of articles) {
      const list = byTenant.get(a.tenantId) ?? [];
      list.push(a);
      byTenant.set(a.tenantId, list);
    }
    for (const [tenantId, list] of byTenant) this.indexes.set(tenantId, new TenantIndex(list));
  }

  async search({ tenantId, query, limit, preferCategory }: KbSearchQuery): Promise<KbHit[]> {
    if (!tenantId) throw new Error('tenantId 는 필수입니다');
    return this.indexes.get(tenantId)?.search(query, limit, preferCategory) ?? [];
  }
}
