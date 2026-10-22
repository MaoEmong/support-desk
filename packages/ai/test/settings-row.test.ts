import { describe, expect, it } from 'vitest';
import { AIConfigError } from '../src/config';
import { loadSeedBundle } from '../src/data';
import { processInquiry } from '../src/pipeline';
import {
  assertCategoryIdsUnchanged,
  parseTenantSettingsRow,
  safeParseTenantSettingsRow,
  tenantSettingsToRow,
  type TenantSettingsRow,
} from '../src/settings-row';
import { input, makeDeps } from './helpers';

const seeds = loadSeedBundle();

/** Drizzle select 결과 흉내(다른 컬럼도 섞여 있다) */
function dbRow(slug: string, patch: Partial<TenantSettingsRow> = {}): TenantSettingsRow {
  const s = seeds.find((t) => t.slug === slug)!.settings;
  return {
    tenantId: 'uuid-1',
    displayName: slug,
    logoUrl: null,
    primaryColor: '#123456',
    version: 3,
    updatedAt: new Date(),
    kbRevision: 7,
    ...tenantSettingsToRow(s),
    ...patch,
  };
}

describe('parseTenantSettingsRow', () => {
  it.each(['pixelforge', 'mailpulse'])('시드 설정은 행으로 바꿨다가 손실 없이 되돌아온다: %s', (slug) => {
    const s = seeds.find((t) => t.slug === slug)!.settings;
    expect(parseTenantSettingsRow(dbRow(slug))).toEqual(s);
  });

  it('Drizzle 행 객체 리터럴(브랜딩·version·kbRevision 포함)을 그대로 받는다', () => {
    const s = seeds.find((t) => t.slug === 'mailpulse')!.settings;
    const parsed = parseTenantSettingsRow({
      tenantId: 't',
      displayName: '메일펄스',
      logoUrl: null,
      primaryColor: null,
      version: 1,
      updatedAt: new Date(),
      kbRevision: 1,
      chatbotName: s.botName,
      aiSystemPrompt: s.systemPrompt,
      aiThreshold: s.threshold,
      approvalMode: s.approvalMode,
      categories: s.categories,
      fallbackCategory: s.fallbackCategory,
      forbiddenCategories: s.forbiddenCategories,
      allowedLinkDomains: s.allowedLinkDomains,
      autoAnswerLimit: 1,
    });
    expect(parsed).toEqual(s);
    expect(Object.keys(parsed)).not.toContain('kbRevision');
  });

  it('real 컬럼이 문자열로 와도 읽는다', () => {
    expect(parseTenantSettingsRow(dbRow('pixelforge', { aiThreshold: '0.7' })).threshold).toBe(0.7);
  });

  it.each<[string, Partial<TenantSettingsRow>, string]>([
    ['autoAnswerLimit 0', { autoAnswerLimit: 0 }, 'autoAnswerLimit'],
    ['autoAnswerLimit 2', { autoAnswerLimit: 2 }, 'autoAnswerLimit'],
    ['금지 카테고리가 categories 밖', { forbiddenCategories: ['refund', 'account_theft'] }, 'forbiddenCategories'],
    ['fallback 이 categories 밖', { fallbackCategory: 'misc' }, 'fallbackCategory'],
    ['categories 가 배열 아님', { categories: { id: 'other' } }, 'categories'],
    ['categories 비어 있음', { categories: [] }, 'categories'],
    ['카테고리 id 형식 위반', { categories: [{ id: 'Other!', label: '기타', keywords: [] }], fallbackCategory: 'Other!' }, 'categories'],
    ['threshold 범위 밖', { aiThreshold: 1.5 }, 'threshold'],
    ['threshold 숫자 아님', { aiThreshold: 'abc' }, 'aiThreshold'],
    ['링크 도메인에 스킴', { allowedLinkDomains: ['https://help.pixelforge.example'] }, 'allowedLinkDomains'],
    ['봇 이름 없음', { chatbotName: null }, 'chatbotName'],
  ])('거부: %s', (_name, patch, field) => {
    const r = safeParseTenantSettingsRow(dbRow('pixelforge', patch));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.issues.join(' ')).toContain(field);
    expect(() => parseTenantSettingsRow(dbRow('pixelforge', patch))).toThrow(AIConfigError);
  });

  it('잘못된 설정을 읽는 SettingsReader 는 자동답변 대신 CONFIG_ERROR 이관이 된다', async () => {
    const deps = makeDeps({ slug: 'pixelforge', message: 'PC로 하려면 사양이 얼마나 필요해요?' });
    deps.settings = { getTenantAISettings: async () => parseTenantSettingsRow(dbRow('pixelforge', { autoAnswerLimit: 0 })) };
    const r = await processInquiry(input('pixelforge'), deps);
    expect(r.decision).toBe('escalate');
    expect(r.reason).toBe('ai_error');
    expect(r.error?.code).toBe('CONFIG_ERROR');
    expect(r.draft).toBeNull();
  });

  it('tenantSettingsToRow 는 계약을 어긴 설정을 저장하지 않는다', () => {
    const s = seeds[0]!.settings;
    expect(() => tenantSettingsToRow({ ...s, autoAnswerLimit: 3 })).toThrow(AIConfigError);
  });
});

describe('assertCategoryIdsUnchanged', () => {
  const prev = [{ id: 'refund' }, { id: 'install' }, { id: 'other' }];
  it('라벨·키워드 수정과 순서 변경은 허용', () => {
    expect(() => assertCategoryIdsUnchanged(prev, [{ id: 'other' }, { id: 'install' }, { id: 'refund' }])).not.toThrow();
  });
  it.each([
    ['추가', [...prev, { id: 'new_one' }]],
    ['삭제', prev.slice(1)],
    ['이름 변경', [{ id: 'refunds' }, { id: 'install' }, { id: 'other' }]],
    ['중복', [...prev, { id: 'other' }]],
  ])('거부: %s', (_n, next) => {
    expect(() => assertCategoryIdsUnchanged(prev, next)).toThrow(AIConfigError);
  });
});
