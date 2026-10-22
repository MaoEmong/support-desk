'use client';

import Link from 'next/link';
import { PortalShell } from '@/components/customer/portal-shell';
import { homeFor, useTenant } from '@/components/tenant-context';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/surface';
import { useMe } from '@/lib/hooks';

/** 테넌트 고객센터 첫 화면. 문구는 테넌트 설정값만 사용한다. */
export default function TenantHome() {
  const { slug, settings, href } = useTenant();
  const me = useMe(slug);
  const user = me.data?.user;

  return (
    <PortalShell>
      <section className="py-6 text-center sm:py-12">
        <h1 className="text-2xl font-bold sm:text-3xl">{settings.displayName} 고객센터</h1>
        <p className="mt-3 text-muted-foreground">
          {settings.chatbotName}에게 먼저 물어보세요. 해결되지 않으면 문의글로 남기면 상담원이 답변드립니다.
        </p>
        <div className="mt-6 flex flex-wrap justify-center gap-2">
          {user ? (
            <Button asChild size="lg">
              <Link href={homeFor(slug, user.role)}>{user.role === 'customer' ? '내 문의 보기' : '관리 화면으로'}</Link>
            </Button>
          ) : (
            <>
              <Button asChild size="lg">
                <Link href={href('/login')}>로그인</Link>
              </Button>
              <Button asChild size="lg" variant="outline">
                <Link href={href('/signup')}>회원가입</Link>
              </Button>
            </>
          )}
        </div>
      </section>
      <div className="grid gap-3 sm:grid-cols-3">
        {[
          [
            '챗봇 상담',
            settings.approvalMode
              ? `${settings.chatbotName}가 문의를 접수하고, 상담원이 확인한 뒤 답변합니다.`
              : `${settings.chatbotName}가 지식베이스를 근거로 바로 답변합니다.`,
          ],
          ['비공개 문의', '작성한 문의는 본인과 상담원만 볼 수 있습니다.'],
          ['처리 상태 확인', '접수부터 답변·해결까지 진행 상황을 확인하세요.'],
        ].map(([t, d]) => (
          <Card key={t}>
            <h2 className="font-semibold">{t}</h2>
            <p className="mt-1 text-sm text-muted-foreground">{d}</p>
          </Card>
        ))}
      </div>
    </PortalShell>
  );
}
