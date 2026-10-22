import { assertCsrfToken, assertJson, assertSameOrigin, isMutating } from './auth/csrf';
import { clearSessionCookies, lookupSession, SESSION_COOKIE, type SessionScope } from './auth/session';
import type { Actor } from './domain';
import { ApiError } from './errors';
import type { Ctx } from './http/context';
import type { AuthMode } from './http/router';

/**
 * 공통 가드. 모든 API 요청은 핸들러 전에 이 함수를 통과한다.
 * 1) /t/{slug} → 테넌트 해석(없음·정지 → 404)
 * 2) 변경 요청 → Origin 검사(+ 인증 전 요청은 JSON 강제)
 * 3) 인증 라우트 → 세션 조회·만료·폐기 확인, 세션 소속 == 경로 테넌트 확인
 * 4) 인증된 변경 요청 → 세션에 묶인 CSRF 토큰 검사
 *
 * tenantId는 오직 여기서(경로 slug + 세션)만 결정된다. 본문·쿼리의 tenantId는 쓰지 않는다.
 */
export async function runGuards(ctx: Ctx, auth: AuthMode) {
  const { repo, cfg } = ctx.deps;
  const slug = ctx.params.slug;

  if (slug !== undefined) {
    const tenant = await repo.getTenantBySlug(slug);
    if (!tenant || tenant.status !== 'active') throw new ApiError('NOT_FOUND');
    ctx.tenant = tenant;
  }

  const mutating = isMutating(ctx.req.method);
  if (mutating) {
    assertSameOrigin(ctx.req, cfg);
    if (auth === 'public') assertJson(ctx.req);
  }

  if (auth === 'public') return;

  const scope: SessionScope = auth === 'platform' ? 'platform' : 'tenant';
  const actor = await authenticate(ctx, scope);

  if (scope === 'tenant') {
    // 다른 테넌트의 세션으로는 이 테넌트에 "로그인되지 않은 것"과 같다.
    if (!ctx.tenant || actor.tenantId !== ctx.tenant.id || actor.role === 'platform_admin') {
      throw new ApiError('UNAUTHENTICATED', undefined, { reason: 'tenant_mismatch' });
    }
  } else if (actor.role !== 'platform_admin' || actor.tenantId !== null) {
    throw new ApiError('UNAUTHENTICATED');
  }

  ctx.actor = actor;
  if (mutating) assertCsrfToken(ctx.req, actor.csrfToken);
}

async function authenticate(ctx: Ctx, scope: SessionScope): Promise<Actor> {
  const { repo, cfg } = ctx.deps;
  const token = ctx.cookies[SESSION_COOKIE[scope]];
  const found = await lookupSession(repo, token, cfg, ctx.now);
  if (found.kind === 'none') throw new ApiError('UNAUTHENTICATED');
  if (found.kind === 'expired') {
    ctx.setCookies.push(...clearSessionCookies(scope, cfg));
    throw new ApiError('SESSION_EXPIRED');
  }
  const s = found.session;
  const user = await repo.getUser(s.userId);
  // 계정 비활성화 시 기존 세션은 즉시 무효
  if (!user || user.status !== 'active' || user.role !== s.role || user.tenantId !== s.tenantId) {
    await repo.revokeSession(s.id, ctx.now);
    ctx.setCookies.push(...clearSessionCookies(scope, cfg));
    throw new ApiError('SESSION_EXPIRED');
  }
  return {
    userId: user.id,
    role: user.role,
    tenantId: user.tenantId,
    name: user.name,
    email: user.email,
    sessionId: s.id,
    csrfToken: s.csrfToken,
  };
}
