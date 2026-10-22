'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { useForm } from 'react-hook-form';
import { z } from 'zod';
import { LoginInputSchema, type DemoAccount } from '@support/contracts';
import { api, fieldErrors, isApiError, type Scope } from '@/lib/api';
import { DEMO_PASSWORD } from '@/lib/demo-accounts';
import type { Me } from '@/lib/types';
import { Button } from './ui/button';
import { Field, Input, fieldAria } from './ui/form-controls';
import { Alert, Card } from './ui/surface';

/**
 * 로그인 폼 스키마: 계약 LoginInputSchema에서 email·password만 사용(테넌트는 경로로 결정).
 * 계약 스키마가 strict라 pick 결과도 strict → 폼 기본값의 name 키 때문에 검증이 화면에 안 보이는 root 오류로 실패해
 * 제출이 막혔다. 폼 검증에서는 남는 키를 버린다(전송 본문은 아래에서 email·password만 보낸다).
 */
const loginSchema = LoginInputSchema.pick({ email: true, password: true }).strip();
/** 가입 스키마: 서버 signupBody와 같은 규칙(이메일·8자 이상 비밀번호·이름 50자) */
const signupSchema = z.object({
  name: z.string().trim().min(1, '이름을 입력해 주세요.').max(50),
  email: z.string().trim().email('올바른 이메일을 입력해 주세요.').max(254),
  password: z.string().min(8, '비밀번호는 8자 이상이어야 합니다.').max(128),
});

type Mode = 'login' | 'signup';

export function AuthForm({
  mode,
  endpoint,
  scope = 'tenant',
  meKey,
  title,
  subtitle,
  redirect,
  altLink,
  demoAccounts = [],
}: {
  mode: Mode;
  endpoint: string;
  scope?: Scope;
  meKey: readonly unknown[];
  title: string;
  subtitle?: string;
  redirect: (me: Me, next: string | null) => string;
  altLink?: { href: string; label: string };
  /** 데모 로그인 버튼(로그인 모드에서만). 비어 있으면 표시하지 않는다 — 표시 여부는 호출부가 visibleDemoAccounts로 정한다. */
  demoAccounts?: readonly DemoAccount[];
}) {
  const router = useRouter();
  const search = useSearchParams();
  const qc = useQueryClient();
  const schema = mode === 'login' ? loginSchema : signupSchema;
  type Values = z.input<typeof signupSchema>;
  const form = useForm<Values>({
    resolver: zodResolver(schema as unknown as typeof signupSchema),
    defaultValues: { name: '', email: '', password: '' },
  });

  const m = useMutation({
    mutationFn: (v: Values) =>
      api<Me>(endpoint, { method: 'POST', scope, body: mode === 'login' ? { email: v.email, password: v.password } : v }),
    onSuccess: (me) => {
      qc.clear();
      qc.setQueryData(meKey, me);
      router.replace(redirect(me, search.get('next')));
    },
    onError: (e) => {
      for (const [k, msg] of Object.entries(fieldErrors(e))) {
        if (k === 'email' || k === 'password' || k === 'name') form.setError(k, { message: msg });
      }
    },
  });

  const err = m.error;
  const errMsg = !err
    ? null
    : isApiError(err) && err.code === 'TOO_MANY_ATTEMPTS'
      ? `로그인 시도가 너무 많습니다.${err.retryAfter ? ` ${Math.ceil(err.retryAfter / 60)}분 후` : ' 잠시 후'} 다시 시도해 주세요.`
      : err.message;
  const expired = search.get('expired') === '1';
  const errors = form.formState.errors;

  return (
    <Card className="mx-auto w-full max-w-sm">
      <h1 className="text-xl font-bold">{title}</h1>
      {subtitle && <p className="mt-1 text-sm text-muted-foreground">{subtitle}</p>}
      {expired && !err && (
        <Alert tone="warning" className="mt-4">
          세션이 만료되었습니다. 다시 로그인해 주세요.
        </Alert>
      )}
      {errMsg && (
        <Alert tone="danger" className="mt-4">
          {errMsg}
        </Alert>
      )}
      <form className="mt-4 space-y-4" noValidate onSubmit={form.handleSubmit((v) => m.mutate(v))}>
        {mode === 'signup' && (
          <Field id="name" label="이름" error={errors.name?.message}>
            <Input {...fieldAria('name', errors.name?.message)} autoComplete="name" {...form.register('name')} />
          </Field>
        )}
        <Field id="email" label="이메일" error={errors.email?.message}>
          <Input {...fieldAria('email', errors.email?.message)} type="email" autoComplete="email" inputMode="email" {...form.register('email')} />
        </Field>
        <Field id="password" label="비밀번호" error={errors.password?.message} hint={mode === 'signup' ? '8자 이상' : undefined}>
          <Input
            {...fieldAria('password', errors.password?.message, mode === 'signup')}
            type="password"
            autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
            {...form.register('password')}
          />
        </Field>
        <Button type="submit" className="w-full" disabled={m.isPending}>
          {m.isPending ? '처리 중…' : mode === 'login' ? '로그인' : '가입하기'}
        </Button>
      </form>
      {mode === 'login' && demoAccounts.length > 0 && (
        // 같은 로그인 mutation(API·CSRF·오류 표시·리다이렉트)으로 바로 제출한다
        <fieldset className="mt-5 min-w-0 border-t border-border pt-4" data-testid="demo-login">
          <legend className="px-1 text-sm font-semibold">데모 계정으로 로그인</legend>
          <ul className="mt-1 space-y-2">
            {demoAccounts.map((a) => (
              <li key={a.email}>
                <Button
                  variant="outline"
                  className="h-auto w-full flex-col items-start gap-0 py-2 text-left"
                  disabled={m.isPending}
                  data-testid={`demo-login-${a.email}`}
                  onClick={() => m.mutate({ name: '', email: a.email, password: DEMO_PASSWORD })}
                >
                  <span className="font-medium">{a.label}</span>
                  <span className="max-w-full break-all text-xs text-muted-foreground">{a.email}</span>
                </Button>
              </li>
            ))}
          </ul>
        </fieldset>
      )}
      {altLink && (
        <p className="mt-4 text-center text-sm">
          <Link href={altLink.href} className="text-info underline-offset-4 hover:underline">
            {altLink.label}
          </Link>
        </p>
      )}
    </Card>
  );
}
