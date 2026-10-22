'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Field, Input } from '@/components/ui/form-controls';
import { Card } from '@/components/ui/surface';

/** 플랫폼 첫 화면: 고객사(테넌트) 고객센터 주소로 이동. 테넌트 목록은 공개하지 않는다. */
export default function Home() {
  const router = useRouter();
  const [slug, setSlug] = useState('');
  return (
    <main id="main" className="mx-auto flex min-h-dvh max-w-md flex-col justify-center px-4 py-10">
      <h1 className="text-2xl font-bold">Support Desk</h1>
      <p className="mt-2 text-sm text-muted-foreground">멀티테넌트 AI 고객지원 헬프데스크</p>
      <Card className="mt-6">
        <form
          className="space-y-3"
          onSubmit={(e) => {
            e.preventDefault();
            const s = slug.trim().toLowerCase();
            if (s) router.push(`/t/${encodeURIComponent(s)}`);
          }}
        >
          <Field id="slug" label="고객센터 주소" hint="예: /t/회사코드">
            <Input id="slug" aria-describedby="slug-hint" value={slug} onChange={(e) => setSlug(e.target.value)} autoCapitalize="none" />
          </Field>
          <Button type="submit" className="w-full">
            이동
          </Button>
        </form>
      </Card>
      <p className="mt-4 text-center text-sm">
        <a href="/platform/login" className="text-info underline-offset-4 hover:underline">
          플랫폼 관리자 로그인
        </a>
      </p>
    </main>
  );
}
