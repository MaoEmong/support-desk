'use client';

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useRouter } from 'next/navigation';
import { api, isApiError, type Scope } from '@/lib/api';

/**
 * 로그아웃. 성공(또는 이미 만료된 세션 401)일 때만 캐시를 비우고 로그인 화면으로 이동한다.
 * 그 밖의 실패(네트워크·CSRF·서버 오류)는 세션이 살아 있을 수 있으므로 이동하지 않고 오류로 남긴다
 * → 호출한 shell이 logout.isError일 때 안내(role=alert)를 표시한다.
 */
export function useLogout(path: string, loginHref: string, scope: Scope = 'tenant') {
  const qc = useQueryClient();
  const router = useRouter();
  return useMutation({
    mutationFn: async () => {
      try {
        await api<void>(path, { method: 'POST', scope });
      } catch (e) {
        if (isApiError(e) && e.status === 401) return;
        throw e;
      }
    },
    onSuccess: () => {
      qc.clear();
      router.replace(loginHref);
    },
  });
}

export const logoutErrorMessage = (e: unknown) =>
  `로그아웃하지 못했습니다. ${e instanceof Error && e.message ? e.message : '잠시 후 다시 시도해 주세요.'}`;
