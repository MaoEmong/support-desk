import { describe, expect, it } from 'vitest';
import { ConversationMessageSchema, CreateAgentInputSchema, CreateAgentResponseSchema, UpdateAgentInputSchema, formatPublicSSE, SSEEventSchema, SSESequenceSchema, SourceSchema, TenantSettingsPatchSchema } from '../src/index';

const conversationId = '10000000-0000-4000-8000-000000000001';
const classified = { event: 'classified', data: { category: 'install', conversationId } };
const sources = { event: 'sources', data: { sources: [] } };
const done = { event: 'done', data: { conversationId } };

describe('public boundary safety', () => {
  it('requires the nested agent creation response and disabled-only PATCH', () => {
    const agent = { id: conversationId, name: 'Agent', email: 'agent@example.test', role: 'agent', status: 'active' };
    expect(CreateAgentResponseSchema.safeParse({ agent, temporaryPassword: 'temporary-once' }).success).toBe(true);
    expect(CreateAgentResponseSchema.safeParse({ ...agent, temporaryPassword: 'temporary-once' }).success).toBe(false);
    expect(UpdateAgentInputSchema.safeParse({ status: 'disabled' }).success).toBe(true);
    expect(UpdateAgentInputSchema.safeParse({ status: 'active' }).success).toBe(false);
  });
  it('serializes the validated public envelope without exposing done internals', () => {
    expect(formatPublicSSE(done)).toBe(`event: done\ndata: ${JSON.stringify(done.data)}\n\n`);
    expect(() => formatPublicSSE({ ...done, data: { ...done.data, result: {} } } as never)).toThrow();
  });
  it('allows approved notices only on public system messages', () => {
    const message = { id: conversationId, role: 'system', body: '상담원 확인 후 답변드립니다.', sources: [], escalationReason: 'approval_mode', noticeCode: 'APPROVAL_REQUIRED', createdAt: '2026-10-22T00:00:00.000Z' };
    expect(ConversationMessageSchema.safeParse(message).success).toBe(true);
    expect(ConversationMessageSchema.safeParse({ ...message, noticeCode: 'UNAPPROVED_CODE' }).success).toBe(false);
    expect(ConversationMessageSchema.safeParse({ ...message, role: 'assistant' }).success).toBe(false);
  });
  it('accepts last-write-wins PATCH and rejects version and fixed limit input', () => {
    expect(TenantSettingsPatchSchema.safeParse({ aiThreshold: 0.8 }).success).toBe(true);
    expect(TenantSettingsPatchSchema.safeParse({ autoAnswerLimit: 1 }).success).toBe(false);
    expect(TenantSettingsPatchSchema.safeParse({ version: 1, aiThreshold: 0.8 }).success).toBe(false);
  });
  it('never accepts internal AI results in the terminal public event', () => {
    expect(SSEEventSchema.safeParse({ event: 'done', data: { conversationId, result: { confidence: 0.9 } } }).success).toBe(false);
  });
  it('requires a shared policy reason and a customer notice for escalation', () => {
    expect(SSEEventSchema.safeParse({ event: 'escalated', data: { reason: 'made_up_reason', message: '확인 중' } }).success).toBe(false);
    expect(SSEEventSchema.safeParse({ event: 'escalated', data: { reason: 'approval_mode', message: '상담원 확인 후 답변드립니다.' } }).success).toBe(true);
  });
  it('blocks tokens after escalation and errors while permitting safe terminal sequences', () => {
    const escalation = { event: 'escalated', data: { reason: 'approval_mode', message: '상담원 확인' } };
    expect(SSESequenceSchema.safeParse([classified, sources, escalation, done]).success).toBe(true);
    expect(SSESequenceSchema.safeParse([classified, sources, escalation, { event: 'token', data: { token: 'private draft' } }, done]).success).toBe(false);
    expect(SSESequenceSchema.safeParse([{ event: 'error', data: { code: 'AI_UNAVAILABLE', message: '잠시 후 다시 시도하세요.' } }, done]).success).toBe(true);
    expect(SSESequenceSchema.safeParse([classified, done]).success).toBe(false);
  });
  it('rejects internal source metadata and role injection into agent creation', () => {
    expect(SourceSchema.safeParse({ id: 'kb', title: 'FAQ', excerpt: 'Public excerpt', url: null, tenantId: 'private', score: 0.9 }).success).toBe(false);
    expect(CreateAgentInputSchema.safeParse({ name: 'Agent', email: 'agent@example.test', role: 'platform_admin' }).success).toBe(false);
  });
  it('accepts optional public source detail while rejecting nullable URLs', () => {
    expect(SourceSchema.safeParse({ id: 'kb', title: 'FAQ' }).success).toBe(true);
    expect(SourceSchema.safeParse({ id: 'kb', title: 'FAQ', excerpt: 'Answer', url: 'https://example.test/faq' }).success).toBe(true);
    expect(SourceSchema.safeParse({ id: 'kb', title: 'FAQ', url: null }).success).toBe(false);
  });
});
