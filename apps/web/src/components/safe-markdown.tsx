'use client';

import ReactMarkdown, { type Components } from 'react-markdown';
import rehypeSanitize, { defaultSchema } from 'rehype-sanitize';
import { cn } from '@/lib/utils';

/**
 * 고객 글·AI 답변 렌더링.
 * - 원시 HTML은 렌더링하지 않는다(react-markdown 기본: HTML을 텍스트로 취급) + rehype-sanitize로 한 번 더 거른다.
 * - 링크는 http(s)이면서 허용 도메인(또는 그 하위 도메인)이거나 같은 사이트 상대 경로만 통과. 나머지는 일반 텍스트.
 * - 이미지는 렌더링하지 않는다(추적 픽셀·외부 리소스 차단). 대체 텍스트만 표시.
 */
export function isAllowedHref(href: string | undefined | null, allowedDomains: readonly string[]): boolean {
  if (!href) return false;
  const h = href.trim();
  if (h.startsWith('/') && !h.startsWith('//')) return true;
  let u: URL;
  try {
    u = new URL(h);
  } catch {
    return false;
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return false;
  const host = u.hostname.toLowerCase();
  return allowedDomains.some((d) => {
    const dom = d.toLowerCase();
    return host === dom || host.endsWith(`.${dom}`);
  });
}

const schema = {
  ...defaultSchema,
  tagNames: (defaultSchema.tagNames ?? []).filter((t) => !['img', 'input'].includes(t)),
};

export function SafeMarkdown({ children, allowedDomains = [], className }: { children: string; allowedDomains?: readonly string[]; className?: string }) {
  const components: Components = {
    a: ({ href, children: label }) =>
      isAllowedHref(href, allowedDomains) ? (
        <a href={href} target="_blank" rel="noopener noreferrer nofollow ugc">
          {label}
        </a>
      ) : (
        <span data-blocked-link="true">{label}</span>
      ),
    img: ({ alt }) => (alt ? <span>[이미지: {alt}]</span> : null),
    // 사용자·AI 본문의 # 제목이 페이지 제목(h1)·섹션(h2) 구조를 깨지 않도록 낮춘다(글자·모양은 유지)
    h1: ({ children: c }) => <h3 className="mt-3 text-base font-bold">{c}</h3>,
    h2: ({ children: c }) => <h4 className="mt-3 text-base font-semibold">{c}</h4>,
    h3: ({ children: c }) => <h5 className="mt-2 font-semibold">{c}</h5>,
    h4: ({ children: c }) => <h5 className="mt-2 font-semibold">{c}</h5>,
    h5: ({ children: c }) => <h5 className="mt-2 font-semibold">{c}</h5>,
    h6: ({ children: c }) => <h5 className="mt-2 font-medium">{c}</h5>,
  };
  return (
    <div className={cn('prose-sd text-sm', className)}>
      <ReactMarkdown
        skipHtml
        rehypePlugins={[[rehypeSanitize, schema]]}
        // 허용 판단은 components.a에서 한다. 여기서는 javascript: 등 위험 스킴만 제거.
        urlTransform={(url) => (/^(javascript|vbscript|data):/i.test(url.trim()) ? '' : url)}
        components={components}
      >
        {children}
      </ReactMarkdown>
    </div>
  );
}
