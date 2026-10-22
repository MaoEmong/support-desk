/**
 * DB tenant_settings 행 ↔ TenantAISettings 매핑. 컬럼 이름 대응은 이 파일 한 곳에만 둔다.
 *
 *   chatbotName        → botName
 *   aiSystemPrompt     → systemPrompt
 *   aiThreshold        → threshold
 *   approvalMode, categories(jsonb), fallbackCategory, forbiddenCategories(jsonb),
 *   allowedLinkDomains(jsonb), autoAnswerLimit → 같은 이름
 *
 * 검증에 실패하면 AIConfigError 를 던진다. SettingsReader 가 이 예외를 그대로 올리면
 * 파이프라인은 error.code=CONFIG_ERROR 로 이관(reason ai_error)한다 — 잘못된 설정으로 자동답변하지 않는다.
 */
import { z } from 'zod/v4';
import type { CategoryDef, TenantAISettings } from './contracts';
import { TenantAISettingsSchema } from './contracts';
import { AIConfigError } from './config';

/** 이번 범위의 자동답변 한도(회의 결정: 1 고정) */
export const AUTO_ANSWER_LIMIT = 1;

/** Drizzle select 결과(카멜 케이스)의 해당 컬럼. 다른 컬럼(tenantId, displayName 등)이 더 있어도 된다. */
export interface TenantSettingsRow {
  chatbotName: string | null;
  aiSystemPrompt: string | null;
  /** real 컬럼. 드라이버에 따라 문자열로 올 수 있다 */
  aiThreshold: number | string;
  approvalMode: boolean;
  /** jsonb: CategoryDef[] */
  categories: unknown;
  fallbackCategory: string;
  /** jsonb: string[] */
  forbiddenCategories: unknown;
  /** jsonb: string[] */
  allowedLinkDomains: unknown;
  autoAnswerLimit: number;
  /** 그 밖의 컬럼(tenantId, displayName, logoUrl, primaryColor, version, updatedAt, kbRevision …)은 무시한다 */
  [otherColumn: string]: unknown;
}

/** insert/update 에 쓰는 값(시드·관리자 저장). */
// interface 가 아닌 type: 추가 키 허용(index signature) 입력에 그대로 넘길 수 있게 한다.
export type TenantSettingsRowValues = {
  chatbotName: string;
  aiSystemPrompt: string;
  aiThreshold: number;
  approvalMode: boolean;
  categories: CategoryDef[];
  fallbackCategory: string;
  forbiddenCategories: string[];
  allowedLinkDomains: string[];
  autoAnswerLimit: number;
};

const RowSchema = z.object({
  chatbotName: z.string().nullable(),
  aiSystemPrompt: z.string().nullable(),
  aiThreshold: z.union([z.number(), z.string().trim().min(1).transform(Number)]).pipe(z.number().finite()),
  approvalMode: z.boolean(),
  categories: z.unknown(),
  fallbackCategory: z.string(),
  forbiddenCategories: z.unknown(),
  allowedLinkDomains: z.unknown(),
  autoAnswerLimit: z.number().int(),
});

function issuesOf(error: z.ZodError): string[] {
  return error.issues.map((i) => `${i.path.join('.') || '(row)'}: ${i.message}`);
}

export type ParseSettingsRowResult = { ok: true; settings: TenantAISettings } | { ok: false; issues: string[] };

export function safeParseTenantSettingsRow(row: TenantSettingsRow): ParseSettingsRowResult {
  const r = RowSchema.safeParse(row);
  if (!r.success) return { ok: false, issues: issuesOf(r.error) };
  const v = r.data;
  const issues: string[] = [];
  if (v.autoAnswerLimit !== AUTO_ANSWER_LIMIT) issues.push(`autoAnswerLimit: ${AUTO_ANSWER_LIMIT} 이어야 합니다(현재 ${v.autoAnswerLimit})`);
  // null 이면 계약 기본값을 쓰지 않고 실패시킨다(누락을 드러낸다). 빈 프롬프트는 허용.
  if (v.chatbotName === null) issues.push('chatbotName: 값이 없습니다');
  const parsed = TenantAISettingsSchema.safeParse({
    botName: v.chatbotName ?? '',
    systemPrompt: v.aiSystemPrompt ?? '',
    threshold: v.aiThreshold,
    approvalMode: v.approvalMode,
    categories: v.categories,
    fallbackCategory: v.fallbackCategory,
    forbiddenCategories: v.forbiddenCategories,
    allowedLinkDomains: v.allowedLinkDomains,
    autoAnswerLimit: v.autoAnswerLimit,
  });
  if (!parsed.success) issues.push(...issuesOf(parsed.error));
  if (issues.length > 0 || !parsed.success) return { ok: false, issues };
  return { ok: true, settings: parsed.data };
}

/** 검증 실패 시 AIConfigError. SettingsReader 에서 그대로 쓰면 된다. */
export function parseTenantSettingsRow(row: TenantSettingsRow): TenantAISettings {
  const r = safeParseTenantSettingsRow(row);
  if (!r.ok) throw new AIConfigError(`tenant_settings 검증 실패: ${r.issues.join('; ')}`);
  return r.settings;
}

/** 시드·관리자 저장용 역매핑. 저장 전에 계약 검증(카테고리 포함 관계, 한도 1)을 한다. */
export function tenantSettingsToRow(settings: TenantAISettings): TenantSettingsRowValues {
  const values: TenantSettingsRowValues = {
    chatbotName: settings.botName,
    aiSystemPrompt: settings.systemPrompt,
    aiThreshold: settings.threshold,
    approvalMode: settings.approvalMode,
    categories: settings.categories.map((c) => ({ id: c.id, label: c.label, description: c.description, keywords: [...c.keywords] })),
    fallbackCategory: settings.fallbackCategory,
    forbiddenCategories: [...settings.forbiddenCategories],
    allowedLinkDomains: [...settings.allowedLinkDomains],
    autoAnswerLimit: settings.autoAnswerLimit,
  };
  parseTenantSettingsRow(values); // 왕복 검증: 실패하면 저장하지 않는다
  return values;
}

/**
 * 관리자 수정(PATCH)용: 카테고리 id 는 바꿀 수 없다(추가·삭제·변경 모두 거부). label·description·keywords 만 수정 가능.
 * 순서 변경은 허용한다. 위반이면 AIConfigError.
 */
export function assertCategoryIdsUnchanged(prev: readonly Pick<CategoryDef, 'id'>[], next: readonly Pick<CategoryDef, 'id'>[]): void {
  const before = new Set(prev.map((c) => c.id));
  const after = new Set(next.map((c) => c.id));
  const added = [...after].filter((id) => !before.has(id));
  const removed = [...before].filter((id) => !after.has(id));
  if (added.length || removed.length || after.size !== next.length) {
    const parts = [
      added.length ? `추가 ${added.join(', ')}` : '',
      removed.length ? `삭제 ${removed.join(', ')}` : '',
      after.size !== next.length ? 'id 중복' : '',
    ].filter(Boolean);
    throw new AIConfigError(`카테고리 id 는 바꿀 수 없습니다(${parts.join(' / ')})`);
  }
}
