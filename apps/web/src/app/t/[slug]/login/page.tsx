'use client';

import { Suspense } from 'react';
import { AuthForm } from '@/components/auth-form';
import { safeNext } from '@/components/auth-guard';
import { PortalShell } from '@/components/customer/portal-shell';
import { homeFor, useTenant } from '@/components/tenant-context';
import { visibleDemoAccounts } from '@/lib/demo-accounts';
import { qk } from '@/lib/hooks';

export default function LoginPage() {
  const { slug, settings, href } = useTenant();
  return (
    <PortalShell>
      <Suspense>
        <AuthForm
          mode="login"
          endpoint={`/t/${encodeURIComponent(slug)}/auth/login`}
          meKey={qk.me(slug)}
          title="로그인"
          subtitle={`${settings.displayName} 계정으로 로그인하세요.`}
          redirect={(me, next) => {
            const n = safeNext(next, slug);
            // 고객은 /admin으로, 상담원은 고객 화면으로 보내지 않는다
            const staff = me.user.role === 'agent' || me.user.role === 'tenant_admin';
            if (n && n.includes('/admin') === staff) return n;
            return homeFor(slug, me.user.role);
          }}
          altLink={{ href: href('/signup'), label: '계정이 없나요? 회원가입' }}
          demoAccounts={visibleDemoAccounts(slug)}
        />
      </Suspense>
    </PortalShell>
  );
}
