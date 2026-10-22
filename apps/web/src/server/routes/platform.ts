import { requireActor } from '../http/context';
import type { Router } from '../http/router';
import { assertCan } from '../policy';
import type { TenantMetrics } from '../repo/types';
import { kpis } from './staff';

/**
 * 플랫폼 관리자: 테넌트 목록과 집계 수치만. 티켓 본문·메시지·AI 원문 API는 없다.
 * (테넌트 경로는 tenant 세션만 받으므로 platform 세션으로는 401)
 */
export function registerPlatformRoutes(r: Router) {
  r.add({
    method: 'GET',
    pattern: '/platform/tenants',
    auth: 'platform',
    handler: async (ctx) => {
      assertCan(requireActor(ctx), 'platform:aggregate');
      const tenants = await ctx.deps.repo.listTenants();
      const items = [];
      for (const t of tenants) {
        const m = await ctx.deps.repo.tenantMetrics(t.id);
        items.push({
          id: t.id,
          slug: t.slug,
          name: t.name,
          status: t.status,
          createdAt: t.createdAt,
          metrics: aggregateOnly(m),
        });
      }
      return { items };
    },
  });

  r.add({
    method: 'GET',
    pattern: '/platform/metrics',
    auth: 'platform',
    handler: async (ctx) => {
      assertCan(requireActor(ctx), 'platform:aggregate');
      const tenants = await ctx.deps.repo.listTenants();
      const per = await Promise.all(tenants.map((t) => ctx.deps.repo.tenantMetrics(t.id)));
      const sum = (k: 'ticketsTotal' | 'escalatedTickets' | 'autoResolvedTickets' | 'autoAnsweredTickets' | 'aiRunsTotal' | 'aiRunsFailed') =>
        per.reduce((a, m) => a + m[k], 0);
      const total = {
        ticketsTotal: sum('ticketsTotal'),
        escalatedTickets: sum('escalatedTickets'),
        autoResolvedTickets: sum('autoResolvedTickets'),
        autoAnsweredTickets: sum('autoAnsweredTickets'),
        aiRunsTotal: sum('aiRunsTotal'),
        aiRunsFailed: sum('aiRunsFailed'),
      };
      return { tenantsTotal: tenants.length, tenantsActive: tenants.filter((t) => t.status === 'active').length, ...total, ...kpis(total) };
    },
  });
}

/** 집계 화이트리스트 */
function aggregateOnly(m: TenantMetrics) {
  return {
    ticketsTotal: m.ticketsTotal,
    ticketsByStatus: m.ticketsByStatus,
    escalatedTickets: m.escalatedTickets,
    autoAnsweredTickets: m.autoAnsweredTickets,
    autoResolvedTickets: m.autoResolvedTickets,
    categoryDistribution: m.categoryDistribution,
    aiRunsTotal: m.aiRunsTotal,
    aiRunsFailed: m.aiRunsFailed,
    ...kpis(m),
  };
}
