'use client';

import { keepPreviousData, useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { Suspense } from 'react';
import { EmptyView, ErrorView, LoadingView } from '@/components/states';
import { useTenant } from '@/components/tenant-context';
import { Button } from '@/components/ui/button';
import { Badge, PageHeader } from '@/components/ui/surface';
import { api } from '@/lib/api';
import { qk } from '@/lib/hooks';
import { customerStatusLabel, customerStatusTone } from '@/lib/labels';
import type { CustomerTicket, Page } from '@/lib/types';
import { formatDate } from '@/lib/utils';

const PAGE_SIZE = 20;

export default function MyTicketsPage() {
  return (
    <Suspense fallback={<LoadingView />}>
      <MyTickets />
    </Suspense>
  );
}

function MyTickets() {
  const { slug, href } = useTenant();
  const search = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  const page = Math.max(1, Number.parseInt(search.get('page') ?? '1', 10) || 1);

  const q = useQuery({
    queryKey: qk.tickets(slug, page),
    queryFn: () => api<Page<CustomerTicket>>(`/t/${encodeURIComponent(slug)}/tickets?page=${page}&pageSize=${PAGE_SIZE}`),
    placeholderData: keepPreviousData,
    // 오류 상태에서는 폴링을 멈춘다(재시도는 버튼으로)
    refetchInterval: (query) => (query.state.status === 'error' ? false : 15_000),
  });

  const goTo = (p: number) => router.push(p <= 1 ? pathname : `${pathname}?page=${p}`);
  const newButton = (
    <Button asChild>
      <Link href={href('/tickets/new')}>문의하기</Link>
    </Button>
  );

  return (
    <>
      <PageHeader title="내 문의" description="작성한 문의는 본인과 상담원만 볼 수 있습니다." actions={newButton} />
      {/* 이미 받은 목록이 있으면 갱신 실패에도 목록을 유지하고 오류만 위에 표시 */}
      {q.isError && q.data && <ErrorView inline error={q.error} retry={() => q.refetch()} homeHref={href()} loginHref={href('/login')} />}
      {q.isPending ? (
        <LoadingView label="문의 목록을 불러오는 중" />
      ) : !q.data ? (
        <ErrorView error={q.error} retry={() => q.refetch()} homeHref={href()} loginHref={href('/login')} />
      ) : q.data.items.length === 0 && page === 1 ? (
        <EmptyView title="아직 남긴 문의가 없습니다" description="궁금한 점이나 문제가 있으면 문의를 남겨 주세요." action={newButton} />
      ) : (
        <TicketList data={q.data} page={page} onPage={goTo} fetching={q.isFetching && q.isPlaceholderData} />
      )}
    </>
  );
}

function TicketList({ data, page, onPage, fetching }: { data: Page<CustomerTicket>; page: number; onPage: (p: number) => void; fetching: boolean }) {
  const { href } = useTenant();
  const totalPages = Math.max(1, Math.ceil(data.total / data.pageSize));

  return (
    <div aria-busy={fetching || undefined}>
      {data.items.length === 0 ? (
        <EmptyView title="이 페이지에는 문의가 없습니다" action={<Button onClick={() => onPage(1)}>첫 페이지로</Button>} />
      ) : (
        <ul className="divide-y divide-border overflow-hidden rounded-lg border border-border bg-card">
          {data.items.map((t) => (
            <li key={t.id}>
              <Link
                href={href(`/tickets/${t.id}`)}
                data-testid="ticket-row"
                className="flex min-h-14 flex-col gap-1.5 px-4 py-3 hover:bg-muted focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring sm:flex-row sm:items-center sm:justify-between sm:gap-4"
              >
                <span className="min-w-0 break-words font-medium sm:truncate">{t.title}</span>
                <span className="flex shrink-0 items-center gap-2 text-xs text-muted-foreground">
                  <Badge tone={customerStatusTone[t.customerStatus]} data-testid="ticket-status">
                    {customerStatusLabel[t.customerStatus]}
                  </Badge>
                  <time dateTime={t.createdAt}>{formatDate(t.createdAt)}</time>
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
      {totalPages > 1 && (
        <nav aria-label="페이지 이동" className="mt-4 flex items-center justify-between gap-2">
          <Button variant="outline" onClick={() => onPage(page - 1)} disabled={page <= 1}>
            이전
          </Button>
          <span className="text-sm text-muted-foreground" aria-live="polite">
            {page} / {totalPages} 페이지 · 총 {data.total}건
          </span>
          <Button variant="outline" onClick={() => onPage(page + 1)} disabled={page >= totalPages}>
            다음
          </Button>
        </nav>
      )}
    </div>
  );
}
