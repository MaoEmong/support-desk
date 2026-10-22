/**
 * 오류 규약: 응답 본문은 항상 { code, message, details }.
 * - 401 미인증 / 403 역할 부족 / 404 존재 숨김(다른 고객·다른 테넌트 포함) / 409 충돌
 */
export type ErrorCode =
  | 'UNAUTHENTICATED'
  | 'SESSION_EXPIRED'
  | 'INVALID_CREDENTIALS'
  | 'TOO_MANY_ATTEMPTS'
  | 'CSRF_FAILED'
  | 'FORBIDDEN'
  | 'NOT_FOUND'
  | 'VALIDATION_FAILED'
  | 'CONFLICT'
  | 'VERSION_CONFLICT'
  | 'INVALID_TRANSITION'
  | 'TICKET_CLOSED'
  | 'EMAIL_TAKEN'
  | 'JOB_IN_PROGRESS'
  | 'METHOD_NOT_ALLOWED'
  | 'UNSUPPORTED_MEDIA_TYPE'
  | 'INTERNAL';

const STATUS: Record<ErrorCode, number> = {
  UNAUTHENTICATED: 401,
  SESSION_EXPIRED: 401,
  INVALID_CREDENTIALS: 401,
  TOO_MANY_ATTEMPTS: 429,
  CSRF_FAILED: 403,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  VALIDATION_FAILED: 400,
  CONFLICT: 409,
  VERSION_CONFLICT: 409,
  INVALID_TRANSITION: 409,
  TICKET_CLOSED: 409,
  EMAIL_TAKEN: 409,
  JOB_IN_PROGRESS: 409,
  METHOD_NOT_ALLOWED: 405,
  UNSUPPORTED_MEDIA_TYPE: 415,
  INTERNAL: 500,
};

const DEFAULT_MESSAGE: Partial<Record<ErrorCode, string>> = {
  UNAUTHENTICATED: '로그인이 필요합니다.',
  SESSION_EXPIRED: '세션이 만료되었습니다. 다시 로그인해 주세요.',
  INVALID_CREDENTIALS: '이메일 또는 비밀번호가 올바르지 않습니다.',
  TOO_MANY_ATTEMPTS: '로그인 시도가 너무 많습니다. 잠시 후 다시 시도해 주세요.',
  CSRF_FAILED: '요청 검증에 실패했습니다. 페이지를 새로고침해 주세요.',
  FORBIDDEN: '권한이 없습니다.',
  NOT_FOUND: '찾을 수 없습니다.',
  VALIDATION_FAILED: '입력값이 올바르지 않습니다.',
  CONFLICT: '요청이 현재 상태와 충돌합니다.',
  VERSION_CONFLICT: '다른 사용자가 먼저 변경했습니다. 새로고침 후 다시 시도해 주세요.',
  INVALID_TRANSITION: '허용되지 않는 상태 변경입니다.',
  TICKET_CLOSED: '종료된 문의입니다.',
  EMAIL_TAKEN: '이미 가입된 이메일입니다.',
  JOB_IN_PROGRESS: '이미 처리 중인 작업이 있습니다.',
  INTERNAL: '서버 오류가 발생했습니다.',
};

export class ApiError extends Error {
  readonly status: number;
  constructor(
    readonly code: ErrorCode,
    message?: string,
    readonly details?: unknown,
    readonly headers?: Record<string, string>,
  ) {
    super(message ?? DEFAULT_MESSAGE[code] ?? code);
    this.status = STATUS[code];
  }
}

export const notFound = () => new ApiError('NOT_FOUND');
export const forbidden = () => new ApiError('FORBIDDEN');
export const unauthenticated = () => new ApiError('UNAUTHENTICATED');

export function errorResponse(err: unknown): Response {
  if (err instanceof ApiError) {
    return Response.json(
      { code: err.code, message: err.message, details: err.details ?? null },
      { status: err.status, headers: err.headers },
    );
  }
  // 내부 오류 상세는 응답에 싣지 않는다(로그만).
  console.error('[api] unhandled error', err instanceof Error ? err.stack : err);
  return Response.json(
    { code: 'INTERNAL', message: DEFAULT_MESSAGE.INTERNAL, details: null },
    { status: 500 },
  );
}
