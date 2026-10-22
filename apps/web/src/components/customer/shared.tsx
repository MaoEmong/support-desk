import type { ParseParams, ZodErrorMap } from 'zod';
import type { PublicSource } from '@/lib/types';
import { isAllowedHref } from '../safe-markdown';
import { cn } from '@/lib/utils';

/** 고객 폼 검증 메시지(계약 스키마의 기본 영문 메시지 대신). path 첫 키 → 필드 이름 */
export function koreanErrorMap(names: Record<string, string>): ZodErrorMap {
  return (issue, ctx) => {
    const name = names[String(issue.path[0] ?? '')] ?? '내용';
    if (issue.code === 'too_small' && issue.type === 'string') {
      return { message: Number(issue.minimum) <= 1 ? `${name}을(를) 입력해 주세요.` : `${name}은(는) ${issue.minimum}자 이상이어야 합니다.` };
    }
    if (issue.code === 'too_big' && issue.type === 'string') {
      return { message: `${name}은(는) ${Number(issue.maximum).toLocaleString('ko-KR')}자 이하로 입력해 주세요.` };
    }
    return { message: ctx.defaultError };
  };
}

/** zodResolver 두 번째 인자용(타입이 ParseParams 전체를 요구해 기본값 path·async를 함께 채운다) */
export const resolverParams = (errorMap: ZodErrorMap): ParseParams => ({ errorMap, path: [], async: true });

/**
 * 답변 근거("참고한 문서"). 본문 링크와 같은 규칙(isAllowedHref)으로 허용된 URL만 링크로 만들고,
 * 그 밖의 URL은 제목 + URL 텍스트(링크 아님)로 보여준다.
 * allowedDomains: 지금은 공개 설정에 허용 도메인이 없어 기본 [] → 같은 사이트 상대 경로만 링크.
 * 공개 설정에 allowedLinkDomains가 생기면 그 값을 넘긴다.
 */
export function SourceList({ sources, className, allowedDomains = [] }: { sources: PublicSource[]; className?: string; allowedDomains?: readonly string[] }) {
  if (sources.length === 0) return null;
  return (
    <div className={cn('mt-3 border-t border-border pt-2', className)} data-testid="message-sources">
      <p className="text-xs font-semibold text-muted-foreground">참고한 문서</p>
      <ul className="mt-1 space-y-1.5">
        {sources.map((s) => (
          <li key={s.id} className="text-sm">
            {s.url && isAllowedHref(s.url, allowedDomains) ? (
              <a href={s.url} target="_blank" rel="noopener noreferrer" className="break-words font-medium text-info underline underline-offset-2">
                {s.title}
                <span className="sr-only"> (새 창)</span>
              </a>
            ) : (
              <>
                <span className="break-words font-medium">{s.title}</span>
                {s.url && <span className="block break-all text-xs text-muted-foreground">{s.url}</span>}
              </>
            )}
            {s.excerpt && <p className="mt-0.5 line-clamp-2 break-words text-xs text-muted-foreground">{s.excerpt}</p>}
          </li>
        ))}
      </ul>
    </div>
  );
}
