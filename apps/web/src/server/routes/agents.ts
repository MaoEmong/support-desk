import { randomUUID } from 'node:crypto';
import { hashPassword, randomToken } from '../auth/crypto';
import type { User } from '../domain';
import { ApiError } from '../errors';
import { readBody, requireActor } from '../http/context';
import type { Router } from '../http/router';
import { assertCan } from '../policy';
import { isUniqueViolation } from '../repo/types';
import { createAgentBody, idParam, updateAgentBody } from '../validation';

/**
 * 상담원 관리. 목록은 배정 후보로 agent도 읽고, 생성·비활성은 tenant_admin만.
 * role(agent)·tenantId(세션 테넌트)·비밀번호(서버 임시 생성)는 요청으로 바꿀 수 없다.
 */
export function registerAgentRoutes(r: Router) {
  r.add({
    method: 'GET',
    pattern: '/t/:slug/admin/agents',
    auth: 'tenant',
    handler: async (ctx) => {
      const actor = requireActor(ctx);
      assertCan(actor, 'agents:read');
      const tenantId = actor.tenantId!;
      const [staff, load] = await Promise.all([ctx.deps.repo.listStaff(tenantId), ctx.deps.repo.countOpenAssigned(tenantId)]);
      return { items: staff.map((u) => toAgent(u, load[u.id] ?? 0)) };
    },
  });

  // 임시 비밀번호는 이 응답에서 한 번만 내려간다(저장은 bcrypt 해시만, 감사 기록·로그에 남기지 않음)
  r.add({
    method: 'POST',
    pattern: '/t/:slug/admin/agents',
    auth: 'tenant',
    handler: async (ctx) => {
      const actor = requireActor(ctx);
      assertCan(actor, 'agents:manage');
      const body = await readBody(ctx, createAgentBody);
      const tenantId = actor.tenantId!;
      const temporaryPassword = randomToken(12);
      const passwordHash = await hashPassword(temporaryPassword, ctx.deps.cfg.bcryptRounds);
      let user: User;
      try {
        user = await ctx.deps.repo.tx(async (tx) => {
          if (await tx.findUserByEmail(tenantId, body.email)) throw new ApiError('EMAIL_TAKEN');
          const u = await tx.createUser(
            { id: randomUUID(), tenantId, email: body.email, passwordHash, name: body.name, role: 'agent', status: 'active' },
            ctx.now,
          );
          await tx.audit({ tenantId, actorId: actor.userId, action: 'agent.create', targetType: 'user', targetId: u.id, meta: { role: 'agent' } }, ctx.now);
          return u;
        });
      } catch (e) {
        if (isUniqueViolation(e)) throw new ApiError('EMAIL_TAKEN');
        throw e;
      }
      return Response.json({ agent: agentCore(user), temporaryPassword }, { status: 201 });
    },
  });

  // 비활성화: 상태 변경 + 세션 전부 폐기 + 감사 기록을 한 트랜잭션으로
  r.add({
    method: 'PATCH',
    pattern: '/t/:slug/admin/agents/:id',
    auth: 'tenant',
    handler: async (ctx) => {
      const actor = requireActor(ctx);
      assertCan(actor, 'agents:manage');
      const id = idParam(ctx, 'id');
      const body = await readBody(ctx, updateAgentBody);
      const tenantId = actor.tenantId!;
      if (id === actor.userId) throw new ApiError('FORBIDDEN', '자기 자신은 비활성화할 수 없습니다.', { reason: 'self' });
      const result = await ctx.deps.repo.tx(async (tx) => {
        const target = await tx.getTenantUser(tenantId, id);
        if (!target) throw new ApiError('NOT_FOUND');
        if (target.role !== 'agent') throw new ApiError('FORBIDDEN', '상담원 계정만 비활성화할 수 있습니다.', { reason: 'not_agent' });
        if (target.status === body.status) return { user: target, revoked: 0 };
        const updated = await tx.updateUserStatusIf(tenantId, id, 'active', body.status, ctx.now);
        if (!updated) throw new ApiError('CONFLICT');
        const revoked = await tx.revokeUserSessions(id, ctx.now);
        await tx.audit(
          { tenantId, actorId: actor.userId, action: 'agent.disable', targetType: 'user', targetId: id, meta: { revokedSessions: revoked } },
          ctx.now,
        );
        return { user: updated, revoked };
      });
      const load = await ctx.deps.repo.countOpenAssigned(tenantId);
      return { agent: toAgent(result.user, load[id] ?? 0), revokedSessions: result.revoked };
    },
  });
}

const agentCore = (u: User) => ({ id: u.id, name: u.name, email: u.email, role: u.role, status: u.status });

function toAgent(u: User, assignedOpenCount: number) {
  return { ...agentCore(u), assignedOpenCount };
}
