'use client';

import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { qk, useMe } from '@/lib/hooks';
import { useTenant } from '@/components/tenant-context';
import { Badge } from '@/components/ui/surface';
import { isAllowedHref, SafeMarkdown } from '@/components/safe-markdown';
import { decisionReasonLabel, ticketStatusLabel, ticketStatusTone, urgencyLabel, urgencyTone, sentimentLabel, sentimentTone } from '@/lib/labels';
import type { AdminSettings, Agent, CategoryLabel, PublicSource, StaffSource, StaffTicket } from '@/lib/types';

export const AGENT_RESPONSE_KEYS = { agent: 'agent', temporaryPassword: 'temporaryPassword' } as const;
export type AgentCreationResponse = Partial<Record<typeof AGENT_RESPONSE_KEYS.agent, Agent>> & Partial<Record<typeof AGENT_RESPONSE_KEYS.temporaryPassword, string>>;

export function useCategoryLabels(): CategoryLabel[] {
  const {settings} = useTenant();
  return settings.categories ?? [];
}

export function reasonLabel(value: string | null) {
  return value && Object.hasOwn(decisionReasonLabel, value) ? (decisionReasonLabel as Record<string, string>)[value] : value ?? '—';
}

export function useAdminApi() {
  const { slug, href } = useTenant();
  const categories = useCategoryLabels();
  const me = useMe(slug);
  const base = `/t/${encodeURIComponent(slug)}/admin`;
  const agents = useQuery({ queryKey: qk.agents(slug), queryFn: () => api<{ items: Agent[] }>(`${base}/agents`) });
  const settings = useQuery({ queryKey: qk.adminSettings(slug), queryFn: () => api<AdminSettings>(`${base}/settings`), enabled: me.data?.user.role === 'tenant_admin' });
  const categoryLabel = (id: string | null) => id ? categories.find(c => c.id === id)?.label ?? id : '미분류';
  return { slug, href, base, me, agents, categories, categoryLabel, domains: settings.data?.allowedLinkDomains ?? [] };
}

export const dateLabel = (v: string) => new Date(v).toLocaleString('ko-KR');

export function TicketBadges({ ticket: t, categoryLabel = id => id ?? '미분류' }: { ticket: StaffTicket; categoryLabel?: (id: string | null) => string }) {
  return <div className="flex flex-wrap gap-1"><Badge tone={ticketStatusTone[t.status]}>{ticketStatusLabel[t.status]}</Badge><Badge>{categoryLabel(t.category)}</Badge><Badge tone={urgencyTone(t.urgency)}>긴급도: {urgencyLabel(t.urgency)}</Badge><Badge tone={sentimentTone(t.sentiment)}>감정: {sentimentLabel(t.sentiment)}</Badge><Badge tone={t.escalated ? 'warning' : 'neutral'}>{t.escalated ? '상담원 이관' : '이관 없음'}</Badge>{t.escalationReason && <Badge>이관 사유: {reasonLabel(t.escalationReason)}</Badge>}<Badge>담당: {t.assignee?.name ?? '미배정'}</Badge></div>;
}

export function Sources({ sources, domains }: { sources: StaffSource[]; domains: string[] }) {
  if (!sources.length) return null;
  return <details className="mt-3 text-sm"><summary className="cursor-pointer">참고 자료 ({sources.length})</summary><ul className="mt-2 space-y-2">{sources.map((s, i) => <li key={`${s.kbArticleId}-${i}`} className="break-words"><strong>{s.title}</strong>{s.excerpt && <p>{s.excerpt}</p>}{s.url && <SafeMarkdown allowedDomains={domains}>{`[자료 링크](${s.url})`}</SafeMarkdown>}</li>)}</ul></details>;
}

/** Staff message DTOs contain public source fields rather than kbArticleId. */
export function MessageSources({ sources, domains }: { sources: PublicSource[]; domains: string[] }) {
  if (!sources.length) return null;
  return <details className="mt-3 text-sm">
    <summary className="cursor-pointer">참고 자료 ({sources.length})</summary>
    <ul className="mt-2 space-y-2">
      {sources.map((source, index) => <li key={`${source.id}-${index}`} className="[overflow-wrap:anywhere]">
        {source.url && isAllowedHref(source.url, domains)
          ? <a href={source.url} target="_blank" rel="noopener noreferrer nofollow ugc" className="font-semibold text-info underline">{source.title}</a>
          : <strong>{source.title}</strong>}
        {source.excerpt && <p>{source.excerpt}</p>}
      </li>)}
    </ul>
  </details>;
}
