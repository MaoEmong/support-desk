'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import type { ReactNode } from 'react';
import { roleLabel } from '@/lib/labels';
import type { Me } from '@/lib/types';
import { cn } from '@/lib/utils';
import { Button } from '../ui/button';
import { Badge } from '../ui/surface';
import { TenantLogo, useTenant } from '../tenant-context';
import { logoutErrorMessage, useLogout } from '../use-logout';

interface NavItem {
  path: string;
  label: string;
  adminOnly?: boolean;
  exact?: boolean;
}

/** 대시보드 메뉴. adminOnly 항목은 tenant_admin에게만 보인다(라우트 자체도 RequireRole로 막는다). */
export const ADMIN_NAV: NavItem[] = [
  { path: '/admin', label: '티켓 큐', exact: true },
  { path: '/admin/metrics', label: 'KPI' },
  { path: '/admin/kb', label: 'KB / FAQ' },
  { path: '/admin/agents', label: '상담원', adminOnly: true },
  { path: '/admin/settings', label: '설정', adminOnly: true },
];

export function AdminShell({ me, children }: { me: Me; children: ReactNode }) {
  const { slug, href, settings } = useTenant();
  const pathname = usePathname();
  const logout = useLogout(`/t/${encodeURIComponent(slug)}/auth/logout`, href('/login'));
  const items = ADMIN_NAV.filter((n) => !n.adminOnly || me.user.role === 'tenant_admin');

  return (
    <div className="flex min-h-dvh flex-col lg:flex-row">
      <aside className="border-b border-border bg-card lg:sticky lg:top-0 lg:h-dvh lg:w-60 lg:shrink-0 lg:border-b-0 lg:border-r">
        <div className="flex flex-wrap items-center justify-between gap-2 px-4 py-3 lg:flex-col lg:items-start">
          <TenantLogo className="min-w-0 flex-1 lg:w-full lg:flex-none" />
          {settings.aiMode === 'mock' && (
            <Badge tone="warning" data-testid="mock-badge" title="AI_MODE=mock: 키워드 기반 결정적 응답">
              Demo(Mock) 모드
            </Badge>
          )}
        </div>
        <nav aria-label="관리 메뉴" className="flex gap-1 overflow-x-auto px-2 pb-2 lg:flex-col lg:overflow-visible">
          {items.map((n) => {
            const target = href(n.path);
            const active = n.exact ? pathname === target : pathname === target || pathname.startsWith(`${target}/`);
            return (
              <Link
                key={n.path}
                href={target}
                aria-current={active ? 'page' : undefined}
                className={cn(
                  'whitespace-nowrap rounded-md px-3 py-2 text-sm font-medium',
                  active ? 'bg-brand text-brand-foreground' : 'text-foreground hover:bg-muted',
                )}
              >
                {n.label}
              </Link>
            );
          })}
        </nav>
        <div className="hidden border-t border-border px-4 py-3 text-sm lg:block">
          <p className="font-medium [overflow-wrap:anywhere]" data-testid="current-user">
            {me.user.name}
          </p>
          <p className="text-xs text-muted-foreground">{roleLabel[me.user.role]}</p>
          <Button size="sm" variant="outline" className="mt-2 w-full" onClick={() => logout.mutate()} disabled={logout.isPending}>
            로그아웃
          </Button>
        </div>
      </aside>
      <div className="flex min-w-0 flex-1 flex-col">
        <div className="flex items-center justify-between gap-2 border-b border-border bg-card px-4 py-2 text-sm lg:hidden">
          <span className="min-w-0 [overflow-wrap:anywhere]">
            {me.user.name} · {roleLabel[me.user.role]}
          </span>
          <Button size="sm" variant="ghost" onClick={() => logout.mutate()} disabled={logout.isPending}>
            로그아웃
          </Button>
        </div>
        <main id="main" className="mx-auto w-full max-w-6xl flex-1 px-4 py-6 lg:px-8">
          {logout.isError && (
            <p role="alert" className="mb-4 rounded-md border border-danger/30 bg-danger-soft px-4 py-3 text-sm font-medium text-danger">
              {logoutErrorMessage(logout.error)}
            </p>
          )}
          {children}
        </main>
      </div>
    </div>
  );
}
