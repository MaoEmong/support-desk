'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import { useForm } from 'react-hook-form';
import type { z } from 'zod';
import { CreateMessageInputSchema } from '@support/contracts';
import { SafeMarkdown } from '@/components/safe-markdown';
import { SourceList, koreanErrorMap, resolverParams } from '@/components/customer/shared';
import { ErrorView, LoadingView } from '@/components/states';
import { useTenant } from '@/components/tenant-context';
import { Button } from '@/components/ui/button';
import { Dialog, DialogClose, DialogContent, DialogTrigger } from '@/components/ui/dialog';
import { Field, Textarea, fieldAria } from '@/components/ui/form-controls';
import { Alert, Badge, Card } from '@/components/ui/surface';
import { api, fieldErrors, isApiError } from '@/lib/api';
import { qk } from '@/lib/hooks';
import { customerStatusLabel, customerStatusTone } from '@/lib/labels';
import type { CustomerMessage, CustomerTicketDetail } from '@/lib/types';
import { cn, formatDate } from '@/lib/utils';

const POLL_MS = 4_000;
const NO_RETRY = new Set([401, 403, 404]);

export default function TicketDetailPage() {
  const { slug, href } = useTenant();
  const { id } = useParams<{ id: string }>();
  const path = `/t/${encodeURIComponent(slug)}/tickets/${encodeURIComponent(id)}`;

  const q = useQuery({
    queryKey: qk.ticket(slug, id),
    queryFn: () => api<CustomerTicketDetail>(path),
    // 종료된 문의·오류 상태에서는 폴링 중지
    refetchInterval: (query) => (query.state.status === 'error' || query.state.data?.status === 'closed' ? false : POLL_MS),
    retry: (count, e) => !(isApiError(e) && NO_RETRY.has(e.status)) && count < 2,
  });

  if (q.isPending) return <LoadingView label="문의를 불러오는 중" />;
  if (!q.data) return <ErrorView error={q.error} retry={() => q.refetch()} homeHref={href('/tickets')} loginHref={href('/login')} />;
  // 백그라운드 재조회 실패: 이미 받은 상세(작성 중인 댓글 포함)는 그대로 두고 오류·재시도만 위에 표시
  return (
    <>
      {q.isError && <ErrorView inline error={q.error} retry={() => q.refetch()} homeHref={href('/tickets')} loginHref={href('/login')} />}
      <TicketDetail ticket={q.data} path={path} />
    </>
  );
}

function TicketDetail({ ticket, path }: { ticket: CustomerTicketDetail; path: string }) {
  const { slug, href } = useTenant();
  const qc = useQueryClient();
  const applyDetail = (t: CustomerTicketDetail) => {
    qc.setQueryData(qk.ticket(slug, t.id), t);
    void qc.invalidateQueries({ queryKey: ['tickets', slug] });
  };

  return (
    <article className="space-y-5">
      <header>
        <Link href={href('/tickets')} className="inline-flex min-h-10 items-center text-sm text-info underline-offset-4 hover:underline">
          ← 내 문의 목록
        </Link>
        <div className="mt-1 flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
          <h1 className="min-w-0 break-words text-xl font-bold sm:text-2xl">{ticket.title}</h1>
          <Badge tone={customerStatusTone[ticket.customerStatus]} data-testid="ticket-status" className="self-start">
            {customerStatusLabel[ticket.customerStatus]}
          </Badge>
        </div>
        <p className="mt-1 text-xs text-muted-foreground">
          접수 <time dateTime={ticket.createdAt}>{formatDate(ticket.createdAt)}</time>
          {ticket.resolvedAt && (
            <>
              {' · '}해결 <time dateTime={ticket.resolvedAt}>{formatDate(ticket.resolvedAt)}</time>
            </>
          )}
        </p>
      </header>

      <StatusNotice ticket={ticket} />
      <Timeline messages={ticket.messages} />

      {ticket.canConfirmResolved && <ResolveAction path={path} onDone={applyDetail} />}

      {ticket.canComment ? (
        <CommentForm path={path} status={ticket.status} onDone={applyDetail} />
      ) : (
        <Alert tone="info" title="종료된 문의입니다">
          이 문의에는 더 이상 댓글을 남길 수 없습니다. 추가로 도움이 필요하면{' '}
          <Link href={href('/tickets/new')} className="font-medium underline underline-offset-2">
            새 문의를 작성
          </Link>
          해 주세요.
        </Alert>
      )}
    </article>
  );
}

function StatusNotice({ ticket }: { ticket: CustomerTicketDetail }) {
  const { settings } = useTenant();
  switch (ticket.customerStatus) {
    case 'received':
      return (
        <Alert tone="info" title="문의를 확인하고 있습니다">
          {settings.approvalMode
            ? '상담원이 내용을 확인한 후 답변드립니다. 답변이 등록되면 이 화면에 바로 표시됩니다.'
            : '답변이 준비되면 이 화면에 자동으로 표시됩니다. 필요한 경우 상담원이 이어서 확인합니다.'}
        </Alert>
      );
    case 'in_progress':
      return <Alert tone="warning" title="상담원이 처리 중입니다">확인이 끝나는 대로 답변드리겠습니다.</Alert>;
    case 'answered':
      return (
        <Alert tone="success" title="답변이 도착했습니다">
          {ticket.canConfirmResolved ? '문제가 해결되었다면 아래의 해결 확인 버튼을 눌러 주세요.' : '답변 내용을 확인해 주세요.'}
        </Alert>
      );
    case 'resolved':
      return <Alert tone="success" title="해결된 문의입니다">추가로 궁금한 점이 있으면 댓글을 남겨 주세요. 문의가 다시 열립니다.</Alert>;
    default:
      return null;
  }
}

/** 새 공개 답변(고객 외 작성자)이 늘면 스크린리더에 알린다. */
function useNewReplyAnnouncement(messages: CustomerMessage[]) {
  const [announcement, setAnnouncement] = useState('');
  const seen = useRef(messages.length);
  useEffect(() => {
    if (messages.length > seen.current) {
      const fresh = messages.slice(seen.current).filter((m) => m.authorType !== 'customer');
      if (fresh.length > 0) setAnnouncement(`${fresh.at(-1)!.authorName}의 새 답변이 도착했습니다.`);
    }
    seen.current = messages.length;
  }, [messages]);
  return announcement;
}

function Timeline({ messages }: { messages: CustomerMessage[] }) {
  const announcement = useNewReplyAnnouncement(messages);
  return (
    <section aria-label="문의 내용과 답변">
      <p role="status" className="sr-only">
        {announcement}
      </p>
      <ol className="space-y-3">
        {messages.map((m) => (
          <MessageItem key={m.id} m={m} />
        ))}
      </ol>
    </section>
  );
}

function MessageItem({ m }: { m: CustomerMessage }) {
  // 링크 차단의 1차 방어는 서버 sanitize, 화면은 공개 설정의 허용 도메인으로 한 번 더 거른다(2차 방어)
  const domains = useTenant().settings.allowedLinkDomains ?? [];
  if (m.authorType === 'system') {
    return (
      <li data-testid="message" data-author-type="system" className="mx-auto max-w-[90%] rounded-md bg-muted px-3 py-2 text-center text-xs text-muted-foreground">
        <SafeMarkdown allowedDomains={domains}>{m.body}</SafeMarkdown>
      </li>
    );
  }
  const mine = m.authorType === 'customer';
  return (
    <li data-testid="message" data-author-type={m.authorType} className={cn('flex', mine ? 'justify-end' : 'justify-start')}>
      <div
        className={cn(
          'w-fit min-w-0 max-w-[92%] rounded-lg border px-3 py-2.5 sm:max-w-[80%]',
          mine ? 'border-brand/30 bg-muted' : 'border-border bg-card shadow-sm',
        )}
      >
        <div className={cn('mb-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs', mine && 'justify-end')}>
          <span className="font-semibold">{mine ? `${m.authorName} (나)` : m.authorName}</span>
          {m.authorType === 'ai' && <Badge tone="brand">AI 답변</Badge>}
          {m.authorType === 'agent' && <Badge tone="info">상담원</Badge>}
          <time dateTime={m.createdAt} className="text-muted-foreground">
            {formatDate(m.createdAt)}
          </time>
        </div>
        <SafeMarkdown allowedDomains={domains} className="break-words">
          {m.body}
        </SafeMarkdown>
        <SourceList sources={m.sources} allowedDomains={domains} />
      </div>
    </li>
  );
}

function ResolveAction({ path, onDone }: { path: string; onDone: (t: CustomerTicketDetail) => void }) {
  const [open, setOpen] = useState(false);
  const m = useMutation({
    mutationFn: () => api<CustomerTicketDetail>(`${path}/resolve`, { method: 'POST' }),
    onSuccess: (t) => {
      onDone(t);
      setOpen(false);
    },
  });

  return (
    <Card className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
      <p className="text-sm">답변으로 문제가 해결되었나요?</p>
      <Dialog
        open={open}
        onOpenChange={(v) => {
          setOpen(v);
          if (!v) m.reset();
        }}
      >
        <DialogTrigger asChild>
          <Button data-testid="confirm-resolved" className="shrink-0">
            해결되었어요
          </Button>
        </DialogTrigger>
        <DialogContent title="해결 확인" description="문의를 해결됨으로 표시합니다. 나중에 댓글을 남기면 다시 열 수 있습니다.">
          {m.isError && (
            <Alert tone="danger" className="mb-4">
              {m.error.message}
            </Alert>
          )}
          <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
            <DialogClose asChild>
              <Button variant="outline">취소</Button>
            </DialogClose>
            <Button data-testid="confirm-resolved-submit" onClick={() => m.mutate()} disabled={m.isPending}>
              {m.isPending ? '처리 중…' : '해결 확인'}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </Card>
  );
}

const commentSchema = CreateMessageInputSchema;
type CommentValues = z.input<typeof commentSchema>;
const commentErrorMap = koreanErrorMap({ body: '내용' });

function CommentForm({ path, status, onDone }: { path: string; status: CustomerTicketDetail['status']; onDone: (t: CustomerTicketDetail) => void }) {
  const { slug } = useTenant();
  const qc = useQueryClient();
  const form = useForm<CommentValues>({ resolver: zodResolver(commentSchema, resolverParams(commentErrorMap)), defaultValues: { body: '' } });
  const error = form.formState.errors.body?.message;

  const m = useMutation({
    mutationFn: (v: CommentValues) => api<CustomerTicketDetail>(`${path}/messages`, { method: 'POST', body: v }),
    onSuccess: (t) => {
      onDone(t);
      form.reset({ body: '' });
    },
    onError: (e) => {
      const fe = fieldErrors(e);
      if (fe.body) form.setError('body', { message: fe.body }, { shouldFocus: true });
      // 그 사이 종료됨 → 최신 상태를 불러와 폼을 숨긴다
      if (isApiError(e) && e.code === 'TICKET_CLOSED') void qc.invalidateQueries({ queryKey: ['ticket', slug] });
    },
  });
  const closedError = isApiError(m.error) && m.error.code === 'TICKET_CLOSED';
  const otherError = m.isError && !closedError && !fieldErrors(m.error).body;

  return (
    <Card>
      <h2 className="font-semibold">추가 문의</h2>
      {closedError && (
        <Alert tone="warning" className="mt-3" live>
          문의가 종료되어 댓글을 남길 수 없습니다. 새 문의를 작성해 주세요.
        </Alert>
      )}
      {otherError && (
        <Alert tone="danger" className="mt-3">
          {m.error.message}
        </Alert>
      )}
      <form className="mt-3 space-y-3" noValidate onSubmit={form.handleSubmit((v) => m.mutate(v))}>
        <Field
          id="comment-body"
          label="댓글"
          error={error}
          hint={status === 'resolved' ? '댓글을 남기면 해결된 문의가 다시 열립니다.' : '답변에 대해 더 궁금한 점이나 추가 정보를 남겨 주세요.'}
        >
          <Textarea {...fieldAria('comment-body', error, true)} rows={4} maxLength={20000} {...form.register('body')} />
        </Field>
        <div className="flex justify-end">
          <Button type="submit" disabled={m.isPending} className="w-full sm:w-auto">
            {m.isPending ? '등록 중…' : '댓글 등록'}
          </Button>
        </div>
      </form>
    </Card>
  );
}
