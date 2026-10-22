'use client';

import { usePathname, useRouter } from 'next/navigation';
import { useEffect, type ReactNode } from 'react';
import { useMe } from '@/lib/hooks';
import type { Me, Role } from '@/lib/types';
import { ErrorView, ForbiddenView, LoadingView } from './states';
import { homeFor, useTenant } from './tenant-context';

/**
 * 역할별 라우트 가드(UX용). 실제 격리·권한은 서버가 강제한다.
 * - 미로그인/만료/다른 테넌트 세션(me=401) → 로그인 화면으로 이동(next 유지)
 * - 역할 불일치 → 403 화면
 */
export function RequireRole({ roles, children }: { roles: readonly Role[]; children: (me: Me) => ReactNode }) {
  const { slug, href } = useTenant();
  const me = useMe(slug);
  const router = useRouter();
  const pathname = usePathname();
  const anonymous = me.isSuccess && me.data === null;

  useEffect(() => {
    if (anonymous) router.replace(`${href('/login')}?next=${encodeURIComponent(pathname)}`);
  }, [anonymous, href, pathname, router]);

  if (me.isPending || anonymous) return <LoadingView />;
  if (me.isError) return <ErrorView error={me.error} retry={() => me.refetch()} />;
  if (!roles.includes(me.data!.user.role)) return <ForbiddenView homeHref={homeFor(slug, me.data!.user.role)} />;
  return <>{children(me.data!)}</>;
}

export const STAFF_ROLES: readonly Role[] = ['agent', 'tenant_admin'];
export const ADMIN_ROLES: readonly Role[] = ['tenant_admin'];
export const CUSTOMER_ROLES: readonly Role[] = ['customer'];

/** 로그인 후 이동할 안전한 경로(같은 테넌트 경로만 허용 → 오픈 리다이렉트 방지) */
export function safeNext(next: string | null, slug: string): string | null {
  if (!next) return null;
  const prefix = `/t/${encodeURIComponent(slug)}/`;
  return next.startsWith(prefix) && !next.startsWith('//') ? next : null;
}
