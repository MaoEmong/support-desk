'use client';

import { createContext, useContext, useEffect, type CSSProperties, type ReactNode } from 'react';
import { usePublicSettings } from '@/lib/hooks';
import type { PublicSettings, Role } from '@/lib/types';
import { cn, readableOn } from '@/lib/utils';
import { ErrorView, LoadingView, NotFoundView } from './states';
import { isApiError } from '@/lib/api';

interface TenantCtx {
  slug: string;
  settings: PublicSettings;
  /** /t/{slug} 하위 경로 생성 */
  href: (path?: string) => string;
}

const Ctx = createContext<TenantCtx | null>(null);

export function useTenant(): TenantCtx {
  const v = useContext(Ctx);
  if (!v) throw new Error('useTenant must be used inside <TenantProvider>');
  return v;
}

export const tenantHref = (slug: string, path = '') => `/t/${encodeURIComponent(slug)}${path && !path.startsWith('/') ? `/${path}` : path}`;

/** 역할별 첫 화면 */
export function homeFor(slug: string, role: Role | undefined): string {
  if (role === 'agent' || role === 'tenant_admin') return tenantHref(slug, '/admin');
  if (role === 'customer') return tenantHref(slug, '/tickets');
  return tenantHref(slug);
}

/**
 * 테넌트 공개 설정을 불러와 브랜딩 CSS 변수(--brand, --brand-foreground)를 주입한다.
 * 업종·문구는 하드코딩하지 않고 설정값(displayName, chatbotName, logoUrl, primaryColor)만 쓴다.
 */
export function TenantProvider({ slug, children }: { slug: string; children: ReactNode }) {
  const q = usePublicSettings(slug);

  useEffect(() => {
    if (q.data) document.title = `${q.data.displayName} 고객센터`;
  }, [q.data]);

  if (q.isPending) return <LoadingView />;
  if (q.isError) {
    if (isApiError(q.error) && q.error.status === 404) return <NotFoundView />;
    return <ErrorView error={q.error} retry={() => q.refetch()} />;
  }

  const brand = q.data.primaryColor ?? '#4338ca';
  const style = { '--brand': brand, '--brand-foreground': readableOn(brand) } as CSSProperties;
  const value: TenantCtx = { slug, settings: q.data, href: (p) => tenantHref(slug, p) };

  return (
    <Ctx.Provider value={value}>
      <div style={style} data-tenant={slug} className="min-h-dvh">
        {children}
      </div>
    </Ctx.Provider>
  );
}

export function TenantLogo({ className }: { className?: string }) {
  const { settings } = useTenant();
  return (
    <span className={cn('inline-flex min-w-0 items-center gap-2', className)}>
      {settings.logoUrl ? (
        // 테넌트가 지정한 외부 로고(크기·도메인 미정)라 next/image 대신 img를 쓴다
        <img src={settings.logoUrl} alt="" className="h-7 w-7 shrink-0 rounded object-contain" />
      ) : (
        <span aria-hidden className="flex h-7 w-7 shrink-0 items-center justify-center rounded bg-brand text-sm font-bold text-brand-foreground">
          {settings.displayName.slice(0, 1)}
        </span>
      )}
      <span className="min-w-0 font-semibold [overflow-wrap:anywhere]" data-testid="tenant-name">
        {settings.displayName}
      </span>
    </span>
  );
}
