'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import type { ReactNode } from 'react';
import { useMe } from '@/lib/hooks';
import { cn } from '@/lib/utils';
import { Button } from '../ui/button';
import { TenantLogo, homeFor, useTenant } from '../tenant-context';
import { logoutErrorMessage, useLogout } from '../use-logout';
import { ChatWidget } from './chat-widget';

/** 고객 포털 공통 틀(모바일 우선). 로그인한 고객에게만 챗봇 위젯을 띄운다. */
export function PortalShell({ children }: { children: ReactNode }) {
  const { slug, href } = useTenant();
  const me = useMe(slug);
  const pathname = usePathname();
  const logout = useLogout(`/t/${encodeURIComponent(slug)}/auth/logout`, href('/login'));
  const user = me.data?.user;
  const isCustomer = user?.role === 'customer';

  const nav = isCustomer
    ? [
        { href: href('/tickets'), label: '내 문의' },
        { href: href('/tickets/new'), label: '문의하기' },
      ]
    : [];

  return (
    <div className="flex min-h-dvh flex-col">
      <header className="border-b border-border bg-card">
        <div className="mx-auto flex max-w-4xl flex-wrap items-center justify-between gap-2 px-4 py-3">
          <Link href={href()} className="min-w-0 rounded focus-visible:outline-2">
            <TenantLogo />
          </Link>
          <div className="flex items-center gap-1 sm:gap-2">
            {user ? (
              <>
                {!isCustomer && (
                  <Button asChild size="sm" variant="outline">
                    <Link href={homeFor(slug, user.role)}>관리 화면</Link>
                  </Button>
                )}
                <span className="hidden text-sm text-muted-foreground sm:inline" data-testid="current-user">
                  {user.name}
                </span>
                <Button size="sm" variant="ghost" onClick={() => logout.mutate()} disabled={logout.isPending}>
                  로그아웃
                </Button>
              </>
            ) : me.isSuccess ? (
              <>
                <Button asChild size="sm" variant="ghost">
                  <Link href={href('/login')}>로그인</Link>
                </Button>
                <Button asChild size="sm">
                  <Link href={href('/signup')}>회원가입</Link>
                </Button>
              </>
            ) : null}
          </div>
        </div>
        {nav.length > 0 && (
          <nav aria-label="고객 메뉴" className="mx-auto flex max-w-4xl gap-1 px-4 pb-2">
            {nav.map((n) => {
              const active = pathname === n.href;
              return (
                <Link
                  key={n.href}
                  href={n.href}
                  aria-current={active ? 'page' : undefined}
                  className={cn('rounded-md px-3 py-2 text-sm font-medium', active ? 'bg-brand text-brand-foreground' : 'text-foreground hover:bg-muted')}
                >
                  {n.label}
                </Link>
              );
            })}
          </nav>
        )}
        {logout.isError && (
          <p role="alert" className="mx-auto max-w-4xl px-4 pb-3 text-sm font-medium text-danger">
            {logoutErrorMessage(logout.error)}
          </p>
        )}
      </header>
      <main id="main" className="mx-auto w-full max-w-4xl flex-1 px-4 py-6">
        {children}
      </main>
      {isCustomer && <ChatWidget />}
    </div>
  );
}
