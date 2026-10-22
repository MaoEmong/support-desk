import { ApiError } from '../errors';
import type { ServerConfig } from '../config';
import { safeEqual } from './crypto';

export const CSRF_HEADER = 'x-csrf-token';
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

export const isMutating = (method: string) => !SAFE_METHODS.has(method.toUpperCase());

/**
 * 1차 방어: Origin(없으면 Referer) 검사. 브라우저가 붙이는 값이라 다른 사이트에서 위조할 수 없다.
 * Origin/Referer가 모두 없는 요청(서버 간 호출, 일부 구형 클라이언트)은 아래 토큰 검사에 맡긴다.
 */
export function assertSameOrigin(req: Request, cfg: ServerConfig) {
  const origin = req.headers.get('origin') ?? refererOrigin(req.headers.get('referer'));
  if (!origin) return;
  const allowed = cfg.allowedOrigins.length > 0 ? cfg.allowedOrigins : [new URL(req.url).origin];
  if (!allowed.includes(origin.replace(/\/$/, ''))) {
    throw new ApiError('CSRF_FAILED', undefined, { reason: 'origin_mismatch' });
  }
}

function refererOrigin(ref: string | null): string | null {
  if (!ref) return null;
  try {
    return new URL(ref).origin;
  } catch {
    return null;
  }
}

/** 2차 방어(인증된 변경 요청): 세션에서 파생한 CSRF 토큰과 헤더 값 대조. */
export function assertCsrfToken(req: Request, expected: string) {
  const sent = req.headers.get(CSRF_HEADER);
  if (!sent || !safeEqual(sent, expected)) {
    throw new ApiError('CSRF_FAILED', undefined, { reason: 'token_mismatch' });
  }
}

/** 인증 전 변경 요청(로그인·가입)은 JSON만 받는다. 단순 form POST로 위조할 수 없게 한다. */
export function assertJson(req: Request) {
  const ct = req.headers.get('content-type') ?? '';
  if (!ct.toLowerCase().startsWith('application/json')) {
    throw new ApiError('UNSUPPORTED_MEDIA_TYPE', 'application/json 요청만 허용합니다.');
  }
}
