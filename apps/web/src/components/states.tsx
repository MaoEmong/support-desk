'use client';

import Link from 'next/link';
import type { ReactNode } from 'react';
import { isApiError } from '@/lib/api';
import { cn } from '@/lib/utils';
import { Button } from './ui/button';
import { Card, Spinner } from './ui/surface';

export function LoadingView({ label }: { label?: string }) {
  return (
    <div className="flex min-h-40 items-center justify-center p-6">
      <Spinner label={label} />
    </div>
  );
}

export function EmptyView({ title, description, action }: { title: string; description?: ReactNode; action?: ReactNode }) {
  return (
    <Card className="flex flex-col items-center gap-2 py-10 text-center">
      <p className="font-semibold">{title}</p>
      {description && <p className="text-sm text-muted-foreground">{description}</p>}
      {action && <div className="mt-2">{action}</div>}
    </Card>
  );
}

/**
 * inline: 페이지 일부(섹션·목록) 안의 상태 표시. 페이지 제목(h1)과 겹치지 않게 h2를 쓰고 바깥 여백을 줄인다.
 */
interface ViewProps {
  inline?: boolean;
}

function StatusView({
  code,
  title,
  description,
  children,
  testId,
  inline,
}: { code: string; title: string; description: ReactNode; children?: ReactNode; testId: string } & ViewProps) {
  const Heading = inline ? 'h2' : 'h1';
  return (
    <Card className={cn('text-center [overflow-wrap:anywhere]', inline ? 'my-3' : 'mx-auto my-8 max-w-md')} data-testid={testId}>
      <p className="text-sm font-semibold text-muted-foreground">{code}</p>
      <Heading className={cn('mt-1 font-bold', inline ? 'text-lg' : 'text-xl')}>{title}</Heading>
      <p className="mt-2 text-sm text-muted-foreground">{description}</p>
      {children && <div className={cn('flex flex-wrap justify-center gap-2', inline ? 'mt-3' : 'mt-5')}>{children}</div>}
    </Card>
  );
}

export function NotFoundView({ homeHref, inline }: { homeHref?: string } & ViewProps) {
  return (
    <StatusView code="404" title="페이지를 찾을 수 없습니다" description="존재하지 않거나 접근 권한이 없는 항목입니다." testId="view-404" inline={inline}>
      {homeHref && (
        <Button asChild variant="outline">
          <Link href={homeHref}>처음으로</Link>
        </Button>
      )}
    </StatusView>
  );
}

export function ForbiddenView({ homeHref, inline }: { homeHref?: string } & ViewProps) {
  return (
    <StatusView code="403" title="접근 권한이 없습니다" description="현재 계정의 역할로는 이 화면을 사용할 수 없습니다." testId="view-403" inline={inline}>
      {homeHref && (
        <Button asChild variant="outline">
          <Link href={homeHref}>내 화면으로</Link>
        </Button>
      )}
    </StatusView>
  );
}

export function UnauthenticatedView({ loginHref, expired, inline }: { loginHref: string; expired?: boolean } & ViewProps) {
  return (
    <StatusView
      code="401"
      title={expired ? '세션이 만료되었습니다' : '로그인이 필요합니다'}
      description={expired ? '보안을 위해 다시 로그인해 주세요.' : '이 화면은 로그인한 사용자만 볼 수 있습니다.'}
      testId="view-401"
      inline={inline}
    >
      <Button asChild>
        <Link href={loginHref}>로그인</Link>
      </Button>
    </StatusView>
  );
}

/** 409 충돌: 다른 사용자가 먼저 바꿨을 때. onReload로 최신 데이터를 다시 불러온다. */
export function ConflictNotice({ message, onReload }: { message?: string; onReload: () => void }) {
  return (
    <div role="alert" data-testid="view-409" className="rounded-md border border-warning/30 bg-warning-soft px-4 py-3 text-sm text-warning">
      <p className="font-semibold">충돌이 발생했습니다 (409)</p>
      <p className="mt-1">{message ?? '다른 사용자가 먼저 변경했습니다. 최신 내용을 확인한 뒤 다시 시도해 주세요.'}</p>
      <Button size="sm" variant="outline" className="mt-2" onClick={onReload}>
        최신 내용 불러오기
      </Button>
    </div>
  );
}

/** 쿼리 오류를 상태 코드별 화면으로 */
export function ErrorView({
  error,
  retry,
  homeHref,
  loginHref,
  inline,
}: { error: unknown; retry?: () => void; homeHref?: string; loginHref?: string } & ViewProps) {
  if (isApiError(error)) {
    if (error.status === 404) return <NotFoundView homeHref={homeHref} inline={inline} />;
    if (error.status === 403 && error.code !== 'CSRF_FAILED') return <ForbiddenView homeHref={homeHref} inline={inline} />;
    if (error.status === 401 && loginHref) return <UnauthenticatedView loginHref={loginHref} expired={error.code === 'SESSION_EXPIRED'} inline={inline} />;
  }
  const message = error instanceof Error ? error.message : '알 수 없는 오류가 발생했습니다.';
  return (
    <StatusView code="오류" title="문제가 발생했습니다" description={message} testId="view-error" inline={inline}>
      {retry && <Button onClick={retry}>다시 시도</Button>}
    </StatusView>
  );
}
