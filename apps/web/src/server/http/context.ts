import type { z } from 'zod';
import type { ServerConfig } from '../config';
import type { Actor, Tenant } from '../domain';
import { ApiError } from '../errors';
import type { AiJobQueue } from '../ai/queue';
import type { ChatResponder } from '../ai/chat';
import type { Repo } from '../repo/types';

export interface Deps {
  repo: Repo;
  cfg: ServerConfig;
  queue: AiJobQueue;
  chat: ChatResponder;
  clock: () => Date;
  /** KB 변경 커밋 후 호출(같은 프로세스 KB 캐시 즉시 무효화). 없으면 생략 */
  kbChanged?: (tenantId: string) => void;
}

export interface Ctx {
  req: Request;
  url: URL;
  params: Record<string, string>;
  deps: Deps;
  now: Date;
  ip: string | null;
  cookies: Record<string, string>;
  /** /t/{slug} 경로에서 가드가 채운다 */
  tenant: Tenant | null;
  /** 인증 라우트에서 가드가 채운다 */
  actor: Actor | null;
  /** 응답에 붙일 Set-Cookie */
  setCookies: string[];
}

export function requireTenant(ctx: Ctx): Tenant {
  if (!ctx.tenant) throw new ApiError('INTERNAL', 'tenant guard missing');
  return ctx.tenant;
}

export function requireActor(ctx: Ctx): Actor {
  if (!ctx.actor) throw new ApiError('UNAUTHENTICATED');
  return ctx.actor;
}

const MAX_BODY_BYTES = 64 * 1024;

export async function readBody<S extends z.ZodTypeAny>(ctx: Ctx, schema: S): Promise<z.infer<S>> {
  const ct = ctx.req.headers.get('content-type') ?? '';
  let raw: unknown = {};
  const text = await ctx.req.text();
  if (text.length > MAX_BODY_BYTES) throw new ApiError('VALIDATION_FAILED', '요청 본문이 너무 큽니다.');
  if (text.trim().length > 0) {
    if (!ct.toLowerCase().startsWith('application/json')) throw new ApiError('UNSUPPORTED_MEDIA_TYPE');
    try {
      raw = JSON.parse(text);
    } catch {
      throw new ApiError('VALIDATION_FAILED', 'JSON 형식이 아닙니다.');
    }
  }
  return parseWith(schema, raw);
}

export function readQuery<S extends z.ZodTypeAny>(ctx: Ctx, schema: S): z.infer<S> {
  return parseWith(schema, Object.fromEntries(ctx.url.searchParams.entries()));
}

function parseWith<S extends z.ZodTypeAny>(schema: S, raw: unknown): z.infer<S> {
  const r = schema.safeParse(raw);
  if (!r.success) {
    throw new ApiError(
      'VALIDATION_FAILED',
      undefined,
      r.error.issues.map((i) => ({ path: i.path.map(String).join('.'), message: i.message })),
    );
  }
  return r.data;
}

export function clientIp(req: Request): string | null {
  // 신뢰 프록시 뒤에서 동작한다고 가정(운영 시 프록시 설정과 함께 검토 필요).
  const xff = req.headers.get('x-forwarded-for');
  if (xff) return xff.split(',')[0]!.trim() || null;
  return req.headers.get('x-real-ip');
}
