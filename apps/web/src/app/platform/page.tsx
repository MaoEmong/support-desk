'use client';

import { useQuery } from '@tanstack/react-query';
import { useRouter } from 'next/navigation';
import { useEffect } from 'react';
import { EmptyView, ErrorView, ForbiddenView, LoadingView } from '@/components/states';
import { Button } from '@/components/ui/button';
import { Badge, Card, PageHeader } from '@/components/ui/surface';
import { logoutErrorMessage, useLogout } from '@/components/use-logout';
import { api } from '@/lib/api';
import { qk, usePlatformMe } from '@/lib/hooks';
import type { PlatformMetrics, PlatformTenant } from '@/lib/types';
import { percent } from '@/lib/utils';

/** 플랫폼 관리자: 테넌트 목록·상태·집계 수치만. 티켓·메시지 본문 화면은 없다(서버도 해당 API가 없다). */
export default function PlatformPage() {
  const me = usePlatformMe();
  const router = useRouter();
  const anonymous = me.isSuccess && me.data === null;
  useEffect(() => {
    if (anonymous) router.replace('/platform/login');
  }, [anonymous, router]);

  if (me.isPending || anonymous) return <LoadingView />;
  if (me.isError) return <ErrorView error={me.error} retry={() => me.refetch()} loginHref="/platform/login" />;
  if (me.data!.user.role !== 'platform_admin') return <ForbiddenView />;
  return <PlatformDashboard name={me.data!.user.name} />;
}

function PlatformDashboard({ name }: { name: string }) {
  const tenants = useQuery({ queryKey: qk.platformTenants, queryFn: () => api<{ items: PlatformTenant[] }>('/platform/tenants', { scope: 'platform' }) });
  const metrics = useQuery({ queryKey: qk.platformMetrics, queryFn: () => api<PlatformMetrics>('/platform/metrics', { scope: 'platform' }) });
  const logout = useLogout('/platform/auth/logout', '/platform/login', 'platform');

  return (
    <main id="main" className="mx-auto max-w-6xl px-4 py-6 lg:px-8">
      <PageHeader
        title="플랫폼 관리"
        description="테넌트별 상태와 집계 수치입니다. 문의 본문과 AI 원문은 조회할 수 없습니다."
        actions={
          <>
            <span className="min-w-0 self-center text-sm text-muted-foreground [overflow-wrap:anywhere]">{name}</span>
            <Button variant="outline" size="sm" onClick={() => logout.mutate()} disabled={logout.isPending}>
              로그아웃
            </Button>
          </>
        }
      />
      {logout.isError && (
        <p role="alert" className="mb-4 rounded-md border border-danger/30 bg-danger-soft px-4 py-3 text-sm font-medium text-danger">
          {logoutErrorMessage(logout.error)}
        </p>
      )}

      {metrics.isPending ? (
        <LoadingView />
      ) : metrics.isError ? (
        <ErrorView inline error={metrics.error} retry={() => metrics.refetch()} loginHref="/platform/login" />
      ) : (
        <section aria-label="전체 집계" className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          <Stat label="활성 테넌트" value={`${metrics.data.tenantsActive} / ${metrics.data.tenantsTotal}`} />
          <Stat label="전체 문의" value={metrics.data.ticketsTotal.toLocaleString('ko-KR')} />
          <Stat label="자동해결률" value={percent(metrics.data.autoResolutionRate)} />
          <Stat label="이관률" value={percent(metrics.data.escalationRate)} />
        </section>
      )}

      <h2 className="mb-3 mt-8 text-lg font-semibold">테넌트</h2>
      {tenants.isPending ? (
        <LoadingView />
      ) : tenants.isError ? (
        <ErrorView inline error={tenants.error} retry={() => tenants.refetch()} loginHref="/platform/login" />
      ) : tenants.data.items.length === 0 ? (
        <EmptyView title="등록된 테넌트가 없습니다" />
      ) : (
        <ul className="grid gap-3 md:grid-cols-2">
          {tenants.data.items.map((t) => (
            <li key={t.id} data-testid="platform-tenant">
              <Card>
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="min-w-0 [overflow-wrap:anywhere]">
                    <p className="font-semibold">{t.name}</p>
                    <p className="text-xs text-muted-foreground">/t/{t.slug}</p>
                  </div>
                  <Badge tone={t.status === 'active' ? 'success' : 'danger'}>{t.status === 'active' ? '운영 중' : '정지'}</Badge>
                </div>
                <dl className="mt-4 grid grid-cols-2 gap-x-4 gap-y-2 text-sm sm:grid-cols-3">
                  <Metric label="문의" value={t.metrics.ticketsTotal} />
                  <Metric label="이관" value={t.metrics.escalatedTickets} />
                  <Metric label="자동답변" value={t.metrics.autoAnsweredTickets} />
                  <Metric label="자동해결률" value={percent(t.metrics.autoResolutionRate)} />
                  <Metric label="이관률" value={percent(t.metrics.escalationRate)} />
                  <Metric label="AI 실패" value={`${t.metrics.aiRunsFailed} / ${t.metrics.aiRunsTotal}`} />
                </dl>
              </Card>
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <Card>
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="mt-1 text-2xl font-bold">{value}</p>
    </Card>
  );
}

function Metric({ label, value }: { label: string; value: string | number }) {
  return (
    <div>
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="font-medium">{value}</dd>
    </div>
  );
}
