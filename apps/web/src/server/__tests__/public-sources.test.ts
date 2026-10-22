import { describe, expect, it } from 'vitest';
import { toPublicSources } from '../public-sources';

const policy = { tenantId: 'tenant-a', allowedLinkDomains: ['help.a.example'] };

describe('공개 근거 단일 정책(toPublicSources)', () => {
  it('공개 키만 새 객체로 만들고 tenantId·score 등 내부 필드는 버린다', () => {
    const out = toPublicSources([{ kbArticleId: 'kb-1', title: '설치', excerpt: '요약', tenantId: 'tenant-a', score: 0.9, secret: 'x' }], policy);
    expect(out).toEqual([{ id: 'kb-1', title: '설치', excerpt: '요약' }]);
  });

  it('다른 테넌트로 표시된 항목은 제외한다', () => {
    const out = toPublicSources(
      [
        { kbArticleId: 'kb-1', title: 'A', tenantId: 'tenant-a' },
        { kbArticleId: 'kb-x', title: 'B', tenantId: 'tenant-b' },
      ],
      policy,
    );
    expect(out.map((s) => s.id)).toEqual(['kb-1']);
  });

  it('URL은 https + 허용 도메인(하위 도메인 포함)만 남기고, 아니면 url 키를 생략한다', () => {
    const out = toPublicSources(
      [
        { id: '1', title: 'ok', url: 'https://help.a.example/x' },
        { id: '2', title: 'sub', url: 'https://kb.help.a.example/y' },
        { id: '3', title: 'http', url: 'http://help.a.example/x' },
        { id: '4', title: 'other', url: 'https://evil.example/x' },
        { id: '5', title: 'lookalike', url: 'https://help.a.example.evil.example/x' },
        { id: '6', title: 'js', url: 'javascript:alert(1)' },
        { id: '7', title: 'cred', url: 'https://user:pw@help.a.example/x' },
      ],
      policy,
    );
    expect(out.filter((s) => 'url' in s).map((s) => s.id)).toEqual(['1', '2']);
    expect(out).toHaveLength(7);
    expect(toPublicSources([{ id: '1', title: 't', url: 'https://help.a.example/x' }], { ...policy, allowedLinkDomains: [] })).toEqual([{ id: '1', title: 't' }]);
  });

  it('이전 형식(kbArticleId) 행과 새 형식(id) 행을 모두 같은 공개 형식으로 읽고, 형식이 아니면 버린다', () => {
    expect(toPublicSources([{ kbArticleId: 'old', title: '옛 행' }, { id: 'new', title: '새 행' }, { title: 'id 없음' }, null, 'x'], policy)).toEqual([
      { id: 'old', title: '옛 행' },
      { id: 'new', title: '새 행' },
    ]);
    expect(toPublicSources(null, policy)).toEqual([]);
  });
});
