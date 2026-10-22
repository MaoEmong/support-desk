import {
  ApproveDraftInputSchema,
  ChatInputSchema,
  ConvertConversationInputSchema,
  CreateMessageInputSchema,
  CreateTicketInputSchema,
  LoginInputSchema,
  PaginationSchema,
  StaffMessageInputSchema,
  TenantSettingsPatchSchema,
  TicketStatusSchema,
  UpdateTicketInputSchema,
} from '@support/contracts';
import { z } from 'zod';
import { ApiError } from './errors';
import type { Ctx } from './http/context';

/**
 * 요청 스키마. 공유 계약(@support/contracts)에 있는 것은 그대로 쓰고,
 * 계약에 없는 서버 전용 입력(가입·큐 필터·초안 편집/반려·설정·KB)만 여기서 정의한다.
 */
export const loginBody = LoginInputSchema; // tenantSlug가 와도 무시한다(테넌트는 경로로만 결정)
export const createTicketBody = CreateTicketInputSchema;
export const messageBody = CreateMessageInputSchema;
export const staffMessageBody = StaffMessageInputSchema;
export const updateTicketBody = UpdateTicketInputSchema;
export const approveDraftBody = ApproveDraftInputSchema;
export const chatBody = ChatInputSchema;
export const convertBody = ConvertConversationInputSchema;
export const pageQuery = PaginationSchema;

const text = (max: number) => z.string().trim().min(1).max(max);

export const signupBody = z
  .object({
    email: z.string().trim().toLowerCase().email().max(254),
    password: z.string().min(8).max(128),
    name: text(50),
  })
  .strict();

/** 상담원 생성: role·tenant·비밀번호는 서버가 정한다(본문에 오면 400) */
export const createAgentBody = z
  .object({
    name: text(50),
    email: z.string().trim().toLowerCase().email().max(254),
  })
  .strict();

export const updateAgentBody = z.object({ status: z.literal('disabled') }).strict();

export const queueQuery = PaginationSchema.extend({
  status: TicketStatusSchema.optional(),
  category: z.string().max(50).optional(),
  urgency: z.string().max(20).optional(),
  sentiment: z.string().max(20).optional(),
  /** 'me' | 'none' | 사용자 id */
  assigneeId: z.string().max(64).optional(),
  escalated: z.enum(['true', 'false']).optional(),
});

const version = z.number().int().positive();
export const editDraftBody = z.object({ version, body: text(20_000) }).strict();
export const rejectDraftBody = z.object({ version, reason: z.string().trim().max(500).optional() }).strict();

/**
 * 설정 PATCH 입력은 공유 계약(TenantSettingsPatchSchema, strict) 단일 원천: version·autoAnswerLimit 등 미정의 키는 400.
 * 서버 보안 규칙만 덧붙인다: logoUrl은 https 또는 같은 사이트 상대 경로(javascript:/http: 차단).
 */
export const settingsPatchBody = TenantSettingsPatchSchema.superRefine((v, ctx) => {
  const logo = v.logoUrl;
  if (typeof logo === 'string' && !(logo.startsWith('https://') || (logo.startsWith('/') && !logo.startsWith('//')))) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['logoUrl'], message: 'https 또는 상대 경로만 허용' });
  }
});

export const kbCreateBody = z
  .object({
    title: text(200),
    /** 고객 질문 형태 대표 질문(선택, 비우면 '') */
    question: z.string().trim().max(500).optional(),
    body: text(20_000),
    category: z.string().trim().max(50).nullable().optional(),
    tags: z.array(text(40)).max(20).optional(),
    published: z.boolean().optional(),
  })
  .strict();

export const kbPatchBody = kbCreateBody.partial().strict();

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isUuid = (v: string) => UUID_RE.test(v);

/** 경로 id가 uuid 형식이 아니면 존재하지 않는 것과 같이 404(DB 캐스트 오류 500 방지). */
export function idParam(ctx: Ctx, name: string): string {
  const v = ctx.params[name];
  if (!v || !isUuid(v)) throw new ApiError('NOT_FOUND');
  return v.toLowerCase();
}

export function idempotencyKeyHeader(ctx: Ctx): string | null {
  const v = ctx.req.headers.get('idempotency-key');
  if (!v) return null;
  if (!/^[A-Za-z0-9_.:-]{8,100}$/.test(v)) throw new ApiError('VALIDATION_FAILED', 'Idempotency-Key 형식이 올바르지 않습니다.');
  return v;
}
