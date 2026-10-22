import type { ErrorCode } from '@support/contracts';

/** 세션 영역별 CSRF 쿠키(서버 auth/session.ts와 같은 이름) */
export type Scope = 'tenant' | 'platform';
const CSRF_COOKIE: Record<Scope, string> = { tenant: 'sd_csrf', platform: 'sd_pcsrf' };

export class ApiRequestError extends Error {
  constructor(
    readonly status: number,
    readonly code: ErrorCode | 'NETWORK',
    message: string,
    readonly details: unknown = null,
    readonly retryAfter: number | null = null,
  ) {
    super(message);
  }
}

export const isApiError = (e: unknown): e is ApiRequestError => e instanceof ApiRequestError;

function readCookie(name: string): string | null {
  if (typeof document === 'undefined') return null;
  const hit = document.cookie.split('; ').find((c) => c.startsWith(`${name}=`));
  return hit ? decodeURIComponent(hit.slice(name.length + 1)) : null;
}

export interface ApiOptions {
  method?: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  body?: unknown;
  scope?: Scope;
  headers?: Record<string, string>;
  signal?: AbortSignal;
}

/** fetch 래퍼. GET 외 요청에는 X-CSRF-Token을 붙이고, 오류는 ApiRequestError로 통일한다. */
export async function rawApi(path: string, opts: ApiOptions = {}): Promise<Response> {
  const method = opts.method ?? 'GET';
  const headers: Record<string, string> = { accept: 'application/json', ...opts.headers };
  if (opts.body !== undefined) headers['content-type'] = 'application/json';
  if (method !== 'GET') {
    const token = readCookie(CSRF_COOKIE[opts.scope ?? 'tenant']);
    if (token) headers['x-csrf-token'] = token;
  }
  let res: Response;
  try {
    res = await fetch(`/api${path}`, {
      method,
      headers,
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
      credentials: 'same-origin',
      cache: 'no-store',
      signal: opts.signal,
    });
  } catch (e) {
    if ((e as Error)?.name === 'AbortError') throw e;
    throw new ApiRequestError(0, 'NETWORK', '서버에 연결할 수 없습니다. 네트워크를 확인해 주세요.');
  }
  if (!res.ok) throw await toError(res);
  return res;
}

export async function api<T>(path: string, opts: ApiOptions = {}): Promise<T> {
  const res = await rawApi(path, opts);
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

async function toError(res: Response): Promise<ApiRequestError> {
  let body: { code?: ErrorCode; message?: string; details?: unknown } = {};
  try {
    body = await res.json();
  } catch {
    /* 본문 없는 오류 */
  }
  const retry = res.headers.get('retry-after');
  return new ApiRequestError(
    res.status,
    body.code ?? 'INTERNAL',
    body.message ?? `요청에 실패했습니다 (${res.status}).`,
    body.details ?? null,
    retry ? Number(retry) : null,
  );
}

/** VALIDATION_FAILED details([{path, message}])를 필드별 오류로 바꾼다. */
export function fieldErrors(e: unknown): Record<string, string> {
  if (!isApiError(e) || e.code !== 'VALIDATION_FAILED' || !Array.isArray(e.details)) return {};
  const out: Record<string, string> = {};
  for (const d of e.details as { path?: string | (string | number)[]; message?: string }[]) {
    const key = Array.isArray(d.path) ? d.path.join('.') : d.path;
    if (key && d.message && !out[key]) out[key] = d.message;
  }
  return out;
}

/** 재시도 안전한 요청용 Idempotency-Key */
export const newIdempotencyKey = () =>
  typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : `k-${Date.now()}-${Math.random().toString(36).slice(2)}`;
