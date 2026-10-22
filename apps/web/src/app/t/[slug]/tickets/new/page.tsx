'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { useForm } from 'react-hook-form';
import type { z } from 'zod';
import { CreateTicketInputSchema } from '@support/contracts';
import { koreanErrorMap, resolverParams } from '@/components/customer/shared';
import { useTenant } from '@/components/tenant-context';
import { Button } from '@/components/ui/button';
import { Field, Input, Textarea, fieldAria } from '@/components/ui/form-controls';
import { Alert, Card, PageHeader } from '@/components/ui/surface';
import { api, fieldErrors, newIdempotencyKey } from '@/lib/api';
import { qk } from '@/lib/hooks';
import type { CustomerTicketDetail } from '@/lib/types';

const schema = CreateTicketInputSchema.omit({ conversationId: true });
type Values = z.input<typeof schema>;
const errorMap = koreanErrorMap({ title: '제목', body: '내용' });

export default function NewTicketPage() {
  const { slug, href, settings } = useTenant();
  const router = useRouter();
  const qc = useQueryClient();
  // 폼 마운트 시 1회 생성: 네트워크 재시도·이중 제출에도 같은 키 → 서버가 같은 티켓을 돌려준다
  const [idempotencyKey] = useState(newIdempotencyKey);

  const form = useForm<Values>({
    resolver: zodResolver(schema, resolverParams(errorMap)),
    defaultValues: { title: '', body: '' },
  });
  const errors = form.formState.errors;

  const m = useMutation({
    mutationFn: (v: Values) =>
      api<CustomerTicketDetail>(`/t/${encodeURIComponent(slug)}/tickets`, {
        method: 'POST',
        body: v,
        headers: { 'Idempotency-Key': idempotencyKey },
      }),
    onSuccess: (t) => {
      qc.setQueryData(qk.ticket(slug, t.id), t);
      void qc.invalidateQueries({ queryKey: ['tickets', slug] });
      router.replace(href(`/tickets/${t.id}`));
    },
    onError: (e) => {
      for (const [k, msg] of Object.entries(fieldErrors(e))) {
        if (k === 'title' || k === 'body') form.setError(k, { message: msg }, { shouldFocus: true });
      }
    },
  });
  const fieldErrorCount = Object.keys(fieldErrors(m.error)).length;

  return (
    <>
      <PageHeader
        title="문의하기"
        description={
          settings.approvalMode
            ? '남겨 주신 문의는 상담원이 확인한 뒤 답변드립니다.'
            : `${settings.chatbotName}가 먼저 확인하고, 필요하면 상담원이 이어서 답변드립니다.`
        }
      />
      <Card>
        {m.isError && fieldErrorCount === 0 && (
          <Alert tone="danger" className="mb-4">
            {m.error.message}
          </Alert>
        )}
        <form className="space-y-4" noValidate onSubmit={form.handleSubmit((v) => m.mutate(v))}>
          <Field id="ticket-title" label="제목" error={errors.title?.message}>
            <Input {...fieldAria('ticket-title', errors.title?.message)} maxLength={200} autoComplete="off" {...form.register('title')} />
          </Field>
          <Field id="ticket-body" label="내용" error={errors.body?.message} hint="문제가 생긴 상황, 시각, 화면에 보인 메시지 등을 적어 주시면 더 빨리 도와드릴 수 있습니다.">
            <Textarea {...fieldAria('ticket-body', errors.body?.message, true)} rows={8} maxLength={20000} {...form.register('body')} />
          </Field>
          <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
            <Button asChild variant="outline">
              <Link href={href('/tickets')}>취소</Link>
            </Button>
            <Button type="submit" disabled={m.isPending}>
              {m.isPending ? '등록 중…' : '문의 등록'}
            </Button>
          </div>
        </form>
      </Card>
    </>
  );
}
