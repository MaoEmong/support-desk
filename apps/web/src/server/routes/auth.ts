import { randomUUID } from 'node:crypto';
import { burnPasswordCheck, hashPassword, sha256, verifyPassword } from '../auth/crypto';
import { accountKey, assertNotThrottled, ipKey, recordAttempt } from '../auth/rate-limit';
import { clearSessionCookies, SESSION_COOKIE, sessionCookies, startSession, type SessionScope } from '../auth/session';
import { toMe, toPublicSettings } from '../dto';
import type { User } from '../domain';
import { ApiError } from '../errors';
import { readBody, requireActor, requireTenant, type Ctx } from '../http/context';
import type { Router } from '../http/router';
import { isUniqueViolation } from '../repo/types';
import { loginBody, signupBody } from '../validation';

export function registerAuthRoutes(r: Router) {
  // ---------- 테넌트 공개 설정(브랜딩) ----------
  r.add({
    method: 'GET',
    pattern: '/t/:slug/settings/public',
    auth: 'public',
    handler: async (ctx) => {
      const tenant = requireTenant(ctx);
      const s = await ctx.deps.repo.getSettings(tenant.id);
      if (!s) throw new ApiError('NOT_FOUND');
      return toPublicSettings(tenant, s, ctx.deps.cfg.aiMode);
    },
  });

  // ---------- 고객 회원가입(테넌트별) ----------
  r.add({
    method: 'POST',
    pattern: '/t/:slug/auth/signup',
    auth: 'public',
    handler: async (ctx) => {
      const tenant = requireTenant(ctx);
      const { repo, cfg } = ctx.deps;
      const body = await readBody(ctx, signupBody);
      // 가입 실패(중복 이메일 탐색 등) 남용 방지: IP별 실패 횟수 제한
      const keys = { account: `signup:${tenant.id}:${ctx.ip ?? 'unknown'}`, ip: null };
      await assertNotThrottled(repo, { ...cfg, loginMaxFailuresPerAccount: 10 }, ctx.now, keys);

      const passwordHash = await hashPassword(body.password, cfg.bcryptRounds);
      let user: User;
      try {
        user = await repo.tx(async (tx) => {
          if (await tx.findUserByEmail(tenant.id, body.email)) throw new ApiError('EMAIL_TAKEN');
          const u = await tx.createUser(
            {
              id: randomUUID(),
              tenantId: tenant.id,
              email: body.email,
              passwordHash,
              name: body.name,
              role: 'customer', // 가입 경로로는 고객만 만들 수 있다
              status: 'active',
            },
            ctx.now,
          );
          await tx.audit({ tenantId: tenant.id, actorId: u.id, action: 'auth.signup', targetType: 'user', targetId: u.id }, ctx.now);
          return u;
        });
      } catch (e) {
        if (e instanceof ApiError || isUniqueViolation(e)) {
          await recordAttempt(repo, ctx.now, keys, false, ctx.ip);
          throw e instanceof ApiError ? e : new ApiError('EMAIL_TAKEN');
        }
        throw e;
      }
      return issueSession(ctx, 'tenant', user, 201);
    },
  });

  // ---------- 테넌트 로그인(customer/agent/tenant_admin) ----------
  r.add({
    method: 'POST',
    pattern: '/t/:slug/auth/login',
    auth: 'public',
    handler: async (ctx) => {
      const tenant = requireTenant(ctx);
      const body = await readBody(ctx, loginBody);
      // 이메일 조회 자체가 tenantId로 한정 → A 테넌트 계정으로 B에 로그인 불가
      const user = await verifyLogin(ctx, tenant.id, body.email, body.password);
      return issueSession(ctx, 'tenant', user, 200);
    },
  });

  r.add({ method: 'POST', pattern: '/t/:slug/auth/logout', auth: 'tenant', handler: (ctx) => logout(ctx, 'tenant') });
  r.add({
    method: 'GET',
    pattern: '/t/:slug/auth/me',
    auth: 'tenant',
    handler: async (ctx) => {
      const a = requireActor(ctx);
      return toMe({ id: a.userId, name: a.name, email: a.email, role: a.role, tenantId: a.tenantId }, a.csrfToken, requireTenant(ctx));
    },
  });

  // ---------- 플랫폼 관리자(별도 세션 영역) ----------
  r.add({
    method: 'POST',
    pattern: '/platform/auth/login',
    auth: 'public',
    handler: async (ctx) => {
      const body = await readBody(ctx, loginBody);
      const user = await verifyLogin(ctx, null, body.email, body.password);
      if (user.role !== 'platform_admin') throw new ApiError('INVALID_CREDENTIALS');
      return issueSession(ctx, 'platform', user, 200);
    },
  });
  r.add({ method: 'POST', pattern: '/platform/auth/logout', auth: 'platform', handler: (ctx) => logout(ctx, 'platform') });
  r.add({
    method: 'GET',
    pattern: '/platform/auth/me',
    auth: 'platform',
    handler: async (ctx) => {
      const a = requireActor(ctx);
      return toMe({ id: a.userId, name: a.name, email: a.email, role: a.role, tenantId: null }, a.csrfToken, null);
    },
  });
}

async function verifyLogin(ctx: Ctx, tenantId: string | null, email: string, password: string): Promise<User> {
  const { repo, cfg } = ctx.deps;
  const keys = { account: accountKey(tenantId, email), ip: ipKey(ctx.ip) };
  await assertNotThrottled(repo, cfg, ctx.now, keys);

  const user = await repo.findUserByEmail(tenantId, email);
  let ok = false;
  if (user) ok = await verifyPassword(password, user.passwordHash);
  else await burnPasswordCheck(password, cfg.bcryptRounds); // 계정 존재 여부를 응답 시간으로 흘리지 않음

  if (!user || !ok || user.status !== 'active') {
    await recordAttempt(repo, ctx.now, keys, false, ctx.ip);
    await repo.audit({ tenantId, actorId: user?.id ?? null, action: 'auth.login_failed', targetType: 'user', targetId: user?.id ?? null }, ctx.now);
    throw new ApiError('INVALID_CREDENTIALS');
  }
  await recordAttempt(repo, ctx.now, keys, true, ctx.ip);
  return user;
}

async function issueSession(ctx: Ctx, scope: SessionScope, user: User, status: number) {
  const { repo, cfg } = ctx.deps;
  // 세션 고정 방지: 기존 쿠키 세션은 폐기하고 항상 새 토큰 발급
  const prev = ctx.cookies[SESSION_COOKIE[scope]];
  if (prev && prev.length <= 200) await repo.revokeSession(sha256(prev), ctx.now);

  const { token, session } = await startSession(repo, user, cfg, ctx.now, {
    ip: ctx.ip,
    userAgent: ctx.req.headers.get('user-agent'),
  });
  await repo.audit({ tenantId: user.tenantId, actorId: user.id, action: 'auth.login', targetType: 'user', targetId: user.id }, ctx.now);
  ctx.setCookies.push(...sessionCookies(scope, token, session.csrfToken, cfg));
  const tenant = scope === 'tenant' ? requireTenant(ctx) : null;
  return Response.json(toMe(user, session.csrfToken, tenant), { status });
}

async function logout(ctx: Ctx, scope: SessionScope) {
  const actor = requireActor(ctx);
  await ctx.deps.repo.revokeSession(actor.sessionId, ctx.now);
  await ctx.deps.repo.audit({ tenantId: actor.tenantId, actorId: actor.userId, action: 'auth.logout', targetType: 'user', targetId: actor.userId }, ctx.now);
  ctx.setCookies.push(...clearSessionCookies(scope, ctx.deps.cfg));
  return new Response(null, { status: 204 });
}
