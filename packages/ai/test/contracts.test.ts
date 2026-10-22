import { describe, expect, it } from 'vitest';
import {
  AIRunResultSchema,
  ClassificationResultSchema,
  formatSSE,
  ProcessInquiryInputSchema,
  SSEEventSchema,
  SYSTEM_PROMPT_MAX,
  TenantAISettingsPatchSchema,
  TenantAISettingsSchema,
} from '../src/contracts';
import { loadEvalSet, loadSeedBundle } from '../src/data';
import * as fx from '../src/fixtures';

describe('contracts: MSW fixtures', () => {
  it('AIRunResult 샘플이 스키마를 통과한다', () => {
    for (const r of [fx.sampleRunAutoAnswer, fx.sampleRunEscalated, fx.sampleRunPendingApproval, fx.sampleRunAiError]) {
      expect(() => AIRunResultSchema.parse(r)).not.toThrow();
    }
  });

  it('SSE 샘플 시퀀스가 스키마를 통과하고 done 으로 끝난다', () => {
    for (const seq of [fx.sampleSSEAutoAnswer, fx.sampleSSEEscalated]) {
      for (const ev of seq) expect(() => SSEEventSchema.parse(ev)).not.toThrow();
      expect(seq.at(-1)?.type).toBe('done');
      expect(seq[0]?.type).toBe('classified');
    }
    expect(fx.sampleSSEEscalated.some((e) => e.type === 'token')).toBe(false);
  });

  it('설정 샘플·분류 샘플이 스키마를 통과한다', () => {
    expect(() => TenantAISettingsSchema.parse(fx.sampleTenantAISettings)).not.toThrow();
    expect(() => ClassificationResultSchema.parse(fx.sampleClassificationFaq)).not.toThrow();
  });

  it('formatSSE 는 event/data 와이어 포맷을 만든다', () => {
    const wire = formatSSE({ type: 'token', text: '안녕' });
    expect(wire).toBe('event: token\ndata: {"type":"token","text":"안녕"}\n\n');
  });
});

describe('contracts: TenantAISettings 검증', () => {
  const base = fx.sampleTenantAISettings;

  it('threshold 는 0~1', () => {
    expect(TenantAISettingsSchema.safeParse({ ...base, threshold: 1.2 }).success).toBe(false);
    expect(TenantAISettingsSchema.safeParse({ ...base, threshold: -0.1 }).success).toBe(false);
  });

  it(`systemPrompt 는 ${SYSTEM_PROMPT_MAX}자 이하`, () => {
    expect(TenantAISettingsSchema.safeParse({ ...base, systemPrompt: 'a'.repeat(SYSTEM_PROMPT_MAX + 1) }).success).toBe(false);
  });

  it('금지 카테고리·fallback 은 정의된 카테고리여야 한다', () => {
    expect(TenantAISettingsSchema.safeParse({ ...base, forbiddenCategories: ['nope'] }).success).toBe(false);
    expect(TenantAISettingsSchema.safeParse({ ...base, fallbackCategory: 'nope' }).success).toBe(false);
  });

  it('허용 도메인은 호스트 이름만', () => {
    expect(TenantAISettingsSchema.safeParse({ ...base, allowedLinkDomains: ['https://evil.example/x'] }).success).toBe(false);
  });

  it('패치 스키마는 알 수 없는 필드를 거부한다', () => {
    expect(TenantAISettingsPatchSchema.safeParse({ threshold: 0.8 }).success).toBe(true);
    expect(TenantAISettingsPatchSchema.safeParse({ categories: [] }).success).toBe(false);
  });

  it('processInquiry 입력은 ticketId 와 conversationId 중 정확히 하나', () => {
    expect(ProcessInquiryInputSchema.safeParse({ tenantId: 't', messageId: 'm' }).success).toBe(false);
    expect(ProcessInquiryInputSchema.safeParse({ tenantId: 't', messageId: 'm', ticketId: 'a', conversationId: 'b' }).success).toBe(false);
    expect(ProcessInquiryInputSchema.safeParse({ tenantId: 't', messageId: 'm', ticketId: 'a' }).success).toBe(true);
  });
});

describe('시드 데이터', () => {
  const bundle = loadSeedBundle();

  it('테넌트 2개, 각 KB 20건 이상, 평가 셋 25건 이상', () => {
    expect(bundle.map((b) => b.slug).sort()).toEqual(['mailpulse', 'pixelforge']);
    for (const t of bundle) {
      expect(t.kb.length).toBeGreaterThanOrEqual(20);
      expect(loadEvalSet(t.slug)!.cases.length).toBeGreaterThanOrEqual(25);
    }
  });

  it('평가 셋의 카테고리·근거 id 가 설정·KB 와 맞는다', () => {
    for (const t of bundle) {
      const cats = new Set(t.settings.categories.map((c) => c.id));
      const ids = new Set(t.kb.map((a) => a.id));
      for (const c of loadEvalSet(t.slug)!.cases) {
        expect(cats.has(c.expectedCategory), c.id).toBe(true);
        for (const s of c.expectedSourceIds) expect(ids.has(s), `${c.id} → ${s}`).toBe(true);
        if (t.settings.forbiddenCategories.includes(c.expectedCategory)) expect(c.expectedDecision, c.id).toBe('escalate');
      }
    }
  });
});
