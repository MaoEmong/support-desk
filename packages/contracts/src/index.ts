import { z } from 'zod';
import { PublicDecisionReasonSchema, SourceSchema } from './stage2';
export const RoleSchema = z.enum(['customer', 'agent', 'tenant_admin', 'platform_admin']);
export type Role = z.infer<typeof RoleSchema>;
export const TicketStatusSchema = z.enum(['open', 'in_progress', 'resolved', 'closed']);
export type TicketStatus = z.infer<typeof TicketStatusSchema>;
export const AIRunStatusSchema = z.enum(['queued', 'processing', 'succeeded', 'failed']);
export type AIRunStatus = z.infer<typeof AIRunStatusSchema>;
export const AIDraftStatusSchema = z.enum(['draft', 'approved', 'sent', 'rejected']);
export type AIDraftStatus = z.infer<typeof AIDraftStatusSchema>;
export const customerTicketStatusLabels: Record<TicketStatus, string> = { open: '접수됨', in_progress: '처리 중', resolved: '답변 완료', closed: '종료됨' };
export const ErrorCodeSchema = z.enum(['UNAUTHENTICATED','SESSION_EXPIRED','INVALID_CREDENTIALS','TOO_MANY_ATTEMPTS','CSRF_FAILED','FORBIDDEN','NOT_FOUND','VALIDATION_FAILED','CONFLICT','VERSION_CONFLICT','INVALID_TRANSITION','TICKET_CLOSED','EMAIL_TAKEN','JOB_IN_PROGRESS','METHOD_NOT_ALLOWED','UNSUPPORTED_MEDIA_TYPE','INTERNAL','AI_UNAVAILABLE']);
export type ErrorCode = z.infer<typeof ErrorCodeSchema>;
export const ApiErrorSchema = z.object({ code: ErrorCodeSchema, message: z.string(), details: z.unknown().optional() });
export type ApiError = z.infer<typeof ApiErrorSchema>;
const uuid = z.string().uuid();
const date = z.string().datetime();
export const LoginInputSchema = z.object({ tenantSlug: z.string().min(1).max(100).nullable().optional(), email: z.string().email().max(254).transform(x => x.toLowerCase()), password: z.string().min(1).max(200) }).strict();
export const SessionUserSchema = z.object({ id: uuid, tenantId: uuid.nullable(), email: z.string().email(), name: z.string(), role: RoleSchema });
export type SessionUser = z.infer<typeof SessionUserSchema>;
export const CreateTicketInputSchema = z.object({ title: z.string().trim().min(1).max(200), body: z.string().trim().min(1).max(20000), conversationId: uuid.optional() }).strict();
export type CreateTicketInput = z.infer<typeof CreateTicketInputSchema>;
export const CreateMessageInputSchema = z.object({ body: z.string().trim().min(1).max(20000) }).strict();
export const StaffMessageInputSchema = CreateMessageInputSchema.extend({ visibility: z.enum(['public', 'internal']).default('public') }).strict();
export const UpdateTicketInputSchema = z.object({ version: z.number().int().positive(), status: TicketStatusSchema.optional(), assigneeId: uuid.nullable().optional() }).strict();
export const ApproveDraftInputSchema = z.object({ version: z.number().int().positive(), body: z.string().trim().min(1).max(20000).optional() }).strict();
export const CustomerMessageSchema = z.object({ id: uuid, role: z.enum(['customer', 'agent', 'tenant_admin', 'ai']), body: z.string(), createdAt: date });
export type CustomerMessage = z.infer<typeof CustomerMessageSchema>;
export const CustomerTicketSchema = z.object({ id: uuid, title: z.string(), body: z.string(), status: TicketStatusSchema, version: z.number().int(), createdAt: date, updatedAt: date });
export type CustomerTicket = z.infer<typeof CustomerTicketSchema>;
export const CustomerTicketDetailSchema = CustomerTicketSchema.extend({ messages: z.array(CustomerMessageSchema) });
export type CustomerTicketDetail = z.infer<typeof CustomerTicketDetailSchema>;
export const StaffMessageSchema = CustomerMessageSchema.extend({ tenantId: uuid, ticketId: uuid, authorId: uuid.nullable(), visibility: z.enum(['public','internal']), sourceJobId: uuid.nullable() });
export const StaffTicketSchema = CustomerTicketSchema.extend({ tenantId: uuid, customerId: uuid, assigneeId: uuid.nullable(), escalatedAt: date.nullable(), escalationReason: z.string().nullable(), autoReplyCount: z.number().int(), conversationId: uuid.nullable(), statusLabel: z.string(), category: z.string().nullable(), categoryLabel: z.string().nullable(), urgency: z.string().nullable(), urgencyLabel: z.string().nullable(), sentiment: z.string().nullable(), sentimentLabel: z.string().nullable() });
export type StaffTicket = z.infer<typeof StaffTicketSchema>;
export const StaffDraftSchema = z.object({ id: uuid, ticketId: uuid.nullable(), conversationId: uuid.nullable(), jobId: uuid.nullable(), runId: uuid.nullable(), body: z.string(), status: AIDraftStatusSchema, version: z.number().int().positive(), createdAt: date, updatedAt: date });
export const StaffAIRunSchema = z.object({ id: uuid, jobId: uuid.nullable(), status: AIRunStatusSchema, result: z.record(z.unknown()).nullable(), reason: PublicDecisionReasonSchema.nullable(), confidence: z.number().min(0).max(1).nullable(), createdAt: date, updatedAt: date });
export const StaffTicketDetailSchema = StaffTicketSchema.extend({ messages: z.array(StaffMessageSchema), drafts: z.array(StaffDraftSchema), aiRuns: z.array(StaffAIRunSchema) });
export type StaffTicketDetail = z.infer<typeof StaffTicketDetailSchema>;
export const PaginationSchema = z.object({ page: z.coerce.number().int().min(1).default(1), pageSize: z.coerce.number().int().min(1).max(100).default(20) });
export const ChatInputSchema = z.object({ conversationId: uuid.optional(), body: z.string().trim().min(1).max(10000) }).strict();
export const ConvertConversationInputSchema = z.object({ title: z.string().trim().min(1).max(200) }).strict();
export const SSEEventSchema = z.discriminatedUnion('event', [
 z.object({ event: z.literal('classified'), data: z.object({ category: z.string(), conversationId: uuid }) }),
 z.object({ event: z.literal('token'), data: z.object({ token: z.string() }) }),
 z.object({ event: z.literal('sources'), data: z.object({ sources: z.array(SourceSchema) }) }),
 z.object({ event: z.literal('escalated'), data: z.object({ reason: PublicDecisionReasonSchema, message: z.string().min(1), ticketId: uuid.optional() }).strict() }),
 z.object({ event: z.literal('done'), data: z.object({ conversationId: uuid, messageId: uuid.optional(), ticketId: uuid.optional() }).strict() }),
 z.object({ event: z.literal('error'), data: ApiErrorSchema }),
]);
export type SSEEvent = z.infer<typeof SSEEventSchema>;
/** Public API SSE framing; independent of the AI internal event serializer. */
export function formatPublicSSE(event: SSEEvent): string {
 const parsed = SSEEventSchema.parse(event);
 return `event: ${parsed.event}\ndata: ${JSON.stringify(parsed.data)}\n\n`;
}
export const SSESequenceSchema = z.array(SSEEventSchema).superRefine((events, ctx) => {
  let phase: 'start' | 'classified' | 'sources' | 'escalated' | 'error' | 'done' = 'start';
  events.forEach((entry, index) => {
    const event = entry.event;
    const valid = event === 'error' ? !['done', 'error', 'escalated'].includes(phase)
      : event === 'classified' ? phase === 'start'
      : event === 'sources' ? phase === 'classified'
      : event === 'token' ? phase === 'sources'
      : event === 'escalated' ? phase === 'sources'
      : ['sources', 'escalated', 'error'].includes(phase);
    if (!valid) ctx.addIssue({ code: 'custom', path: [index], message: `공개 SSE 순서 위반: ${event}` });
    if (event !== 'token') phase = event;
  });
  if (events.at(-1)?.event !== 'done') ctx.addIssue({ code: 'custom', message: '공개 SSE는 done으로 종료해야 합니다.' });
});
export {
  PIPELINE_VERSION, CategoryIdSchema, CategoryDefSchema, DECISION_REASONS, UrgencySchema, SentimentSchema,
  ClassificationResultSchema, DecisionSchema, DecisionReasonSchema,
  AIDraftSchema, AIUsageSchema, AITimingSchema, ConfidenceBreakdownSchema,
  AIErrorCodeSchema, AIRunErrorSchema, ProcessInquiryInputSchema, AIRunResultSchema,
  TenantAISettingsSchema, TenantAISettingsPatchSchema,
  SourceSchema as AISourceSchema, SSEEventSchema as AISSEEventSchema,
} from './ai';
export * from './stage2';
export type {
  CategoryId, Urgency, Sentiment, ClassificationResult, Decision, DecisionReason,
  AIDraft, AIUsage, AITiming, ConfidenceBreakdown, AIErrorCode, AIRunError,
  ProcessInquiryInput, AIRunResult, TenantAISettings, TenantAISettingsInput,
  TenantAISettingsPatch, Source as AISource, SSEEvent as AISSEEvent,
} from './ai';
export { DEMO_ACCOUNTS, type DemoAccount } from './demo-accounts';
