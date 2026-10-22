'use client';

import { Suspense } from 'react';
import { AuthForm } from '@/components/auth-form';
import { visibleDemoAccounts } from '@/lib/demo-accounts';
import { qk } from '@/lib/hooks';

export default function PlatformLoginPage() {
  return (
    <main id="main" className="flex min-h-dvh items-center px-4 py-10">
      <Suspense>
        <AuthForm
          mode="login"
          endpoint="/platform/auth/login"
          scope="platform"
          meKey={qk.platformMe}
          title="플랫폼 관리자 로그인"
          subtitle="테넌트 목록과 집계 수치만 조회할 수 있습니다."
          redirect={() => '/platform'}
          demoAccounts={visibleDemoAccounts(null)}
        />
      </Suspense>
    </main>
  );
}
