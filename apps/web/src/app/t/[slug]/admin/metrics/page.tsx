'use client';
import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { qk } from '@/lib/hooks';
import type { TenantMetrics, TicketStatus } from '@/lib/types';
import { ticketStatusLabel } from '@/lib/labels';
import { useTenant } from '@/components/tenant-context';
import { LoadingView, ErrorView, EmptyView } from '@/components/states';
import { Card, PageHeader } from '@/components/ui/surface';

export default function MetricsPage() {
  const {slug,href} = useTenant();
  const query = useQuery({queryKey:qk.metrics(slug),queryFn:() => api<TenantMetrics>(`/t/${encodeURIComponent(slug)}/admin/metrics`)});
  if (query.isPending) return <LoadingView />;
  if (query.isError) return <ErrorView error={query.error} retry={() => query.refetch()} loginHref={href('/login')} />;
  const m = query.data;
  const max = Math.max(1,...Object.values(m.categoryDistribution));
  return <><PageHeader title="지원 통계" description="자동해결률은 전체 문의 중 고객이 해결을 확인한 자동답변 문의의 비율입니다." /><div className="grid gap-4 sm:grid-cols-2"><Card data-testid="kpi-auto-resolution"><h2>자동해결률</h2><p className="mt-2 text-3xl font-bold">{(m.autoResolutionRate*100).toFixed(1)}%</p><p className="text-sm">{m.autoResolvedTickets} / {m.ticketsTotal}건</p></Card><Card data-testid="kpi-escalation"><h2>상담원 이관률</h2><p className="mt-2 text-3xl font-bold">{(m.escalationRate*100).toFixed(1)}%</p><p className="text-sm">{m.escalatedTickets} / {m.ticketsTotal}건</p></Card></div><Card className="mt-5"><h2 className="mb-4 font-semibold">카테고리 분포</h2>{Object.keys(m.categoryDistribution).length ? <ul className="space-y-4">{Object.entries(m.categoryDistribution).map(([label,count]) => <li key={label}><div className="mb-1 flex justify-between gap-2 text-sm"><span className="break-all">{label}</span><span className="shrink-0">{count}건</span></div><div className="h-3 rounded bg-muted" aria-hidden><div className="h-3 rounded bg-brand" style={{width:`${count/max*100}%`}} /></div></li>)}</ul> : <EmptyView title="분류된 문의가 없습니다" />}</Card><Card className="mt-5"><h2 className="mb-3 font-semibold">상태별 문의</h2><dl className="grid grid-cols-2 gap-3 sm:grid-cols-4">{Object.entries(m.ticketsByStatus).map(([s,count]) => <div key={s}><dt>{ticketStatusLabel[s as TicketStatus]}</dt><dd className="text-xl font-bold">{count}건</dd></div>)}</dl></Card></>;
}
