import { z } from 'zod';
import { CategoryDefSchema, DECISION_REASONS, type CategoryDef } from './ai';

// Zod 3 boundary adapter: the AI-owned schema remains the sole category definition.
export const CategoryDefinitionSchema = z.custom<CategoryDef>(value => CategoryDefSchema.safeParse(value).success)
  .transform(value => CategoryDefSchema.parse(value));
export type CategoryDefinition = z.infer<typeof CategoryDefinitionSchema>;
export const PublicDecisionReasonSchema = z.enum(DECISION_REASONS);
export const NoticeCodeSchema = z.enum(['APPROVAL_REQUIRED', 'ESCALATED', 'PROCESSING_FAILED']);
export const SourceSchema = z.object({ id: z.string().min(1), title: z.string(), excerpt: z.string().optional(), url: z.string().url().optional() }).strict();
export const ConversationMessageSchema = z.object({
  id: z.string().uuid(), role: z.enum(['user', 'assistant', 'system']), body: z.string(),
  sources: z.array(SourceSchema),
  escalationReason: PublicDecisionReasonSchema.optional(), noticeCode: NoticeCodeSchema.optional(), createdAt: z.string().datetime(),
}).strict().superRefine((message, ctx) => {
  if (message.role !== 'system' && (message.escalationReason !== undefined || message.noticeCode !== undefined)) {
    ctx.addIssue({ code: 'custom', message: '안내 escalationReason/code는 system 메시지에만 제공합니다.' });
  }
});
export const decisionReasonLabels: Record<(typeof DECISION_REASONS)[number], string> = {
  confident_kb_match: '근거와 신뢰도 충족', approval_mode: '상담원 승인 필요',
  forbidden_category: '상담원 전담 문의', injection_suspected: '안전 확인 필요',
  suspicious_link: '링크 안전 확인 필요', low_confidence: '답변 확신 부족',
  no_sources: '관련 근거 부족', auto_answer_limit: '상담원 후속 처리 필요',
  unsafe_output: '답변 안전 확인 필요', provider_refusal: '상담원 확인 필요', ai_error: '자동 처리 오류',
};
export const urgencyLabels = { low: '낮음', medium: '보통', high: '높음', critical: '긴급' } as const;
export const sentimentLabels = { positive: '긍정', neutral: '중립', negative: '부정', angry: '격앙' } as const;
const domain = z.string().min(1).max(253).regex(/^(?!-)[a-z0-9-]+(\.[a-z0-9-]+)+$/i);
export const TenantSettingsSchema = z.object({
  tenantId: z.string().uuid(), displayName: z.string(), logoUrl: z.string().nullable(), primaryColor: z.string().nullable(),
  chatbotName: z.string().min(1).max(40), aiSystemPrompt: z.string().max(2000), aiThreshold: z.number().min(0).max(1),
  forbiddenCategories: z.array(z.string()), approvalMode: z.boolean(), categories: z.array(CategoryDefinitionSchema).min(1).max(50),
  allowedLinkDomains: z.array(domain).max(20), autoAnswerLimit: z.literal(1),
  fallbackCategory: z.string().min(1), kbRevision: z.number().int().nonnegative(), version: z.number().int().positive(), updatedAt: z.string().datetime(),
}).superRefine((value, ctx) => {
  const ids = new Set(value.categories.map(category => category.id));
  if (ids.size !== value.categories.length) ctx.addIssue({ code: 'custom', path: ['categories'], message: '카테고리 id 중복' });
  if (!ids.has(value.fallbackCategory)) ctx.addIssue({ code: 'custom', path: ['fallbackCategory'], message: '정의되지 않은 카테고리' });
  value.forbiddenCategories.forEach((id, index) => {
    if (!ids.has(id)) ctx.addIssue({ code: 'custom', path: ['forbiddenCategories', index], message: '정의되지 않은 카테고리' });
  });
});
export type TenantSettings = z.infer<typeof TenantSettingsSchema>;
export const TenantSettingsPatchSchema = z.object({
  displayName: z.string().trim().min(1).max(80).optional(),
  logoUrl: z.string().max(500).nullable().optional(), primaryColor: z.string().regex(/^#[0-9a-f]{6}$/i).nullable().optional(),
  chatbotName: z.string().trim().min(1).max(40).optional(), aiSystemPrompt: z.string().max(2000).optional(),
  aiThreshold: z.number().min(0).max(1).optional(), forbiddenCategories: z.array(z.string()).optional(),
  approvalMode: z.boolean().optional(), categories: z.array(CategoryDefinitionSchema).min(1).max(50).optional(),
  allowedLinkDomains: z.array(domain).max(20).optional(),
  fallbackCategory: z.string().min(1).optional(),
}).strict();
export const PublicTenantSettingsSchema = z.object({
  slug: z.string(), name: z.string(), displayName: z.string(), logoUrl: z.string().nullable(), primaryColor: z.string().nullable(),
  chatbotName: z.string(), approvalMode: z.boolean(), categories: z.array(z.object({ id: z.string(), label: z.string() }).strict()),
  allowedLinkDomains: z.array(domain), aiMode: z.enum(['mock', 'claude']),
});
export const AgentStatusSchema = z.enum(['active', 'disabled']);
export const AgentSchema = z.object({
  id: z.string().uuid(), name: z.string(), email: z.string().email(), role: z.enum(['agent', 'tenant_admin']),
  status: AgentStatusSchema, assignedOpenCount: z.number().int().nonnegative(),
});
export type Agent = z.infer<typeof AgentSchema>;
export const CreateAgentInputSchema = z.object({ name: z.string().trim().min(1).max(50), email: z.string().trim().toLowerCase().email().max(254) }).strict();
export const CreateAgentResponseSchema = z.object({ agent: z.object({ id: z.string().uuid(), name: z.string(), email: z.string().email(), role: z.literal('agent'), status: AgentStatusSchema }).strict(), temporaryPassword: z.string().min(8) }).strict();
export const UpdateAgentInputSchema = z.object({ status: z.literal('disabled') }).strict();
export const TenantKPISchema = z.object({
  ticketsTotal: z.number().int().nonnegative(), autoResolvedTickets: z.number().int().nonnegative(),
  escalatedTickets: z.number().int().nonnegative(), autoResolutionRate: z.number().min(0).max(1),
  escalationRate: z.number().min(0).max(1),
  categories: z.array(z.object({ category: z.string(), label: z.string(), count: z.number().int().nonnegative() })),
});
