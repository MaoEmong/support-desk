'use client';

import { Suspense } from 'react';
import { AuthForm } from '@/components/auth-form';
import { PortalShell } from '@/components/customer/portal-shell';
import { homeFor, useTenant } from '@/components/tenant-context';
import { qk } from '@/lib/hooks';

export default function SignupPage() {
  const { slug, settings, href } = useTenant();
  return (
    <PortalShell>
      <Suspense>
        <AuthForm
          mode="signup"
          endpoint={`/t/${encodeURIComponent(slug)}/auth/signup`}
          meKey={qk.me(slug)}
          title="회원가입"
          subtitle={`${settings.displayName} 고객센터는 회원만 문의할 수 있습니다.`}
          redirect={(me) => homeFor(slug, me.user.role)}
          altLink={{ href: href('/login'), label: '이미 계정이 있나요? 로그인' }}
        />
      </Suspense>
    </PortalShell>
  );
}
