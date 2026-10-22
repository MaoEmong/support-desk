'use client';

import { useQuery } from '@tanstack/react-query';
import { api, isApiError } from './api';
import type { Me, PublicSettings } from './types';

export const qk = {
  settings: (slug: string) => ['settings', slug] as const,
  me: (slug: string) => ['me', slug] as const,
  platformMe: ['platform-me'] as const,
  tickets: (slug: string, page: number) => ['tickets', slug, page] as const,
  ticket: (slug: string, id: string) => ['ticket', slug, id] as const,
  queue: (slug: string, filter: Record<string, string | number | undefined>) => ['queue', slug, filter] as const,
  staffTicket: (slug: string, id: string) => ['staff-ticket', slug, id] as const,
  agents: (slug: string) => ['agents', slug] as const,
  metrics: (slug: string) => ['metrics', slug] as const,
  adminSettings: (slug: string) => ['admin-settings', slug] as const,
  kb: (slug: string) => ['kb', slug] as const,
  conversation: (slug: string, id: string) => ['conversation', slug, id] as const,
  platformTenants: ['platform-tenants'] as const,
  platformMetrics: ['platform-metrics'] as const,
};

export function usePublicSettings(slug: string) {
  return useQuery({
    queryKey: qk.settings(slug),
    queryFn: () => api<PublicSettings>(`/t/${encodeURIComponent(slug)}/settings/public`),
    staleTime: 60_000,
  });
}

/** 현재 테넌트 세션. 401(미로그인·만료·다른 테넌트 세션)은 오류가 아니라 null. */
export function useMe(slug: string) {
  return useQuery({
    queryKey: qk.me(slug),
    queryFn: async () => {
      try {
        return await api<Me>(`/t/${encodeURIComponent(slug)}/auth/me`);
      } catch (e) {
        if (isApiError(e) && e.status === 401) return null;
        throw e;
      }
    },
    staleTime: 30_000,
  });
}

export function usePlatformMe() {
  return useQuery({
    queryKey: qk.platformMe,
    queryFn: async () => {
      try {
        return await api<Me>('/platform/auth/me', { scope: 'platform' });
      } catch (e) {
        if (isApiError(e) && e.status === 401) return null;
        throw e;
      }
    },
    staleTime: 30_000,
  });
}
