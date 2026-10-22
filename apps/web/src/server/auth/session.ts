import type { ServerConfig } from '../config';
import type { Session, User } from '../domain';
import { serializeCookie } from '../http/cookies';
import type { Repo } from '../repo/types';
import { randomToken, sha256 } from './crypto';

/**
 * 서버 저장 세션.
 * - 쿠키에는 무작위 토큰만, DB에는 sessions.id = sha256(토큰)만 저장(DB 유출 시 세션 탈취 방지)
 * - 유휴 만료(lastSeenAt + idle) + 절대 만료(expiresAt = createdAt + 최대 수명, 연장하지 않음)
 * - 로그아웃·만료 시 revokedAt 기록 → 같은 토큰 재사용 불가
 * - CSRF 토큰은 세션 행에 저장(csrfToken)하고 요청 헤더와 대조
 * - 테넌트 세션과 플랫폼 관리자 세션은 쿠키 이름이 다르다(세션 영역 분리)
 */
export type SessionScope = 'tenant' | 'platform';

export const SESSION_COOKIE: Record<SessionScope, string> = {
  tenant: 'sd_session',
  platform: 'sd_psession',
};
export const CSRF_COOKIE: Record<SessionScope, string> = {
  tenant: 'sd_csrf',
  platform: 'sd_pcsrf',
};

export async function startSession(
  repo: Repo,
  user: User,
  cfg: ServerConfig,
  now: Date,
  meta: { ip: string | null; userAgent: string | null },
) {
  const token = randomToken();
  const session: Session = {
    id: sha256(token),
    userId: user.id,
    tenantId: user.tenantId,
    role: user.role,
    csrfToken: randomToken(24),
    createdAt: now,
    lastSeenAt: now,
    expiresAt: new Date(now.getTime() + cfg.sessionAbsoluteMs),
    revokedAt: null,
    ip: meta.ip,
    userAgent: meta.userAgent?.slice(0, 256) ?? null,
  };
  await repo.createSession(session);
  return { token, session };
}

export type SessionLookup = { kind: 'none' } | { kind: 'expired' } | { kind: 'ok'; session: Session };

export async function lookupSession(repo: Repo, token: string | undefined, cfg: ServerConfig, now: Date): Promise<SessionLookup> {
  if (!token || token.length > 200) return { kind: 'none' };
  const session = await repo.getSession(sha256(token));
  if (!session) return { kind: 'none' };
  if (session.revokedAt) return { kind: 'expired' };
  const idleDeadline = session.lastSeenAt.getTime() + cfg.sessionIdleMs;
  if (now.getTime() >= session.expiresAt.getTime() || now.getTime() >= idleDeadline) {
    await repo.revokeSession(session.id, now);
    return { kind: 'expired' };
  }
  if (now.getTime() - session.lastSeenAt.getTime() >= cfg.sessionTouchIntervalMs) {
    await repo.touchSession(session.id, now);
  }
  return { kind: 'ok', session };
}

export function sessionCookies(scope: SessionScope, token: string, csrfToken: string, cfg: ServerConfig): string[] {
  const maxAge = cfg.sessionAbsoluteMs / 1000;
  return [
    serializeCookie(SESSION_COOKIE[scope], token, { httpOnly: true, secure: cfg.secureCookies, sameSite: 'Lax', maxAge }),
    // CSRF 토큰은 JS가 읽어 X-CSRF-Token 헤더로 보낸다(서버는 세션 행 값과 대조).
    serializeCookie(CSRF_COOKIE[scope], csrfToken, { httpOnly: false, secure: cfg.secureCookies, sameSite: 'Lax', maxAge }),
  ];
}

export function clearSessionCookies(scope: SessionScope, cfg: ServerConfig): string[] {
  return [
    serializeCookie(SESSION_COOKIE[scope], '', { httpOnly: true, secure: cfg.secureCookies, maxAge: 0 }),
    serializeCookie(CSRF_COOKIE[scope], '', { secure: cfg.secureCookies, maxAge: 0 }),
  ];
}
