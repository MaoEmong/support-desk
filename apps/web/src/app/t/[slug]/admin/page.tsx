'use client';

import Link from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { qk } from '@/lib/hooks';
import type { Page, StaffTicket } from '@/lib/types';
import { ticketStatusLabel, urgencyLabel, sentimentLabel } from '@/lib/labels';
import { useAdminApi, dateLabel, TicketBadges } from '@/components/admin/shared';
import { EmptyView, ErrorView, LoadingView } from '@/components/states';
import { Field, Input, Select } from '@/components/ui/form-controls';
import { Button } from '@/components/ui/button';
import { Alert, Card, PageHeader } from '@/components/ui/surface';

export default function QueuePage() {
  const { slug, base, href, agents, categories, categoryLabel } = useAdminApi();
  const search = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  const filters: Record<string, string> = {};
  for (const key of ['status', 'category', 'urgency', 'sentiment', 'assigneeId', 'escalated', 'page', 'pageSize']) { const value = search.get(key); if (value) filters[key] = value; }
  const query = new URLSearchParams(filters);
  const tickets = useQuery({ queryKey: qk.queue(slug, filters), queryFn: () => api<Page<StaffTicket>>(`${base}/tickets?${query}`), refetchInterval: query => query.state.status === 'error' ? false : 10000 });
  function update(key: string, value: string) { const next = new URLSearchParams(search); if (value) next.set(key, value); else next.delete(key); if (key !== 'page') next.delete('page'); router.replace(`${pathname}?${next}`, { scroll: false }); }
  const selects = [
    ['status', '상태', Object.entries(ticketStatusLabel)],
    ['urgency', '긴급도', ['low','medium','high','critical'].map(v => [v, urgencyLabel(v)])],
    ['sentiment', '감정', ['positive','neutral','negative','angry'].map(v => [v, sentimentLabel(v)])],
    ['assigneeId', '담당자', [['me','나'],['none','미배정'], ...(agents.data?.items.map(a => [a.id,a.name]) ?? [])]],
    ['escalated', '이관 여부', [['true','이관됨'],['false','이관 없음']]],
  ] as const;
  if (!tickets.data && tickets.isError) return <ErrorView error={tickets.error} retry={() => tickets.refetch()} loginHref={href('/login')} />;
  return <><PageHeader title="문의 티켓" description="접수된 문의를 확인하고 상담을 이어가세요. 10초마다 갱신합니다." /><Card className="mb-5 grid gap-3 sm:grid-cols-2 xl:grid-cols-3">{selects.map(([key,label,options]) => <Field key={key} id={`filter-${key}`} label={label}><Select id={`filter-${key}`} value={filters[key] ?? ''} onChange={e => update(key,e.target.value)}><option value="">전체</option>{options.map(([v,l]) => <option key={v} value={v}>{l}</option>)}</Select></Field>)}<Field id="filter-category" label="분류"><Input id="filter-category" list="queue-categories" maxLength={50} value={filters.category ?? ''} onChange={e => update('category',e.target.value)} placeholder="분류 ID 입력 또는 선택" /><datalist id="queue-categories">{categories.map(c => <option key={c.id} value={c.id}>{c.label}</option>)}</datalist></Field><Button variant="outline" onClick={() => router.replace(pathname)}>필터 초기화</Button></Card>
    {tickets.isError && <Alert tone="danger">최신 목록을 불러오지 못했습니다.<Button variant="outline" onClick={() => tickets.refetch()}>다시 시도</Button></Alert>}{!tickets.data ? <LoadingView /> : !tickets.data.items.length ? <EmptyView title="문의가 없습니다" description="필터를 변경하거나 새 문의를 기다려 주세요." /> : <>
      <div className="hidden md:block"><table className="w-full table-fixed text-left text-sm"><thead><tr><th className="w-1/2 p-3">문의 / 분류</th><th className="p-3">고객</th><th className="p-3">접수일</th></tr></thead><tbody>{tickets.data.items.map(t => <tr key={t.id} data-testid="queue-row" className="border-t border-border"><td className="space-y-2 p-3"><Link className="block break-words font-semibold text-info underline" href={href(`/admin/tickets/${t.id}`)}>{t.title}</Link><TicketBadges ticket={t} categoryLabel={categoryLabel} /></td><td className="break-words p-3">{t.customer?.name ?? '고객'}</td><td className="p-3">{dateLabel(t.createdAt)}</td></tr>)}</tbody></table></div>
      <div className="space-y-3 md:hidden">{tickets.data.items.map(t => <Card key={t.id} data-testid="queue-row"><Link className="mb-3 block break-words font-semibold text-info underline" href={href(`/admin/tickets/${t.id}`)}>{t.title}</Link><TicketBadges ticket={t} categoryLabel={categoryLabel} /><p className="mt-3 text-sm">{t.customer?.name ?? '고객'} · {dateLabel(t.createdAt)}</p></Card>)}</div>
    </>}
    {tickets.data && <nav aria-label="티켓 페이지" className="mt-5 flex flex-wrap items-center gap-3"><Button variant="outline" disabled={tickets.data.page <= 1} onClick={() => update('page',String(tickets.data.page-1))}>이전</Button><span>{tickets.data.page} 페이지 · 전체 {tickets.data.total}건</span><Button variant="outline" disabled={tickets.data.page*tickets.data.pageSize >= tickets.data.total} onClick={() => update('page',String(tickets.data.page+1))}>다음</Button></nav>}
  </>;
}
