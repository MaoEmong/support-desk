import { sampleRunAiError, sampleRunAutoAnswer } from '@support/ai/fixtures';
import { describe, expect, it } from 'vitest';
import { normalizeRunResult } from '../dto';

describe('ai_runs.result 읽기 정규화(원본은 result.aiResult)', () => {
  it('워커 envelope·새 SSE 행은 그대로(평탄 필드 보존)', () => {
    const envelope = { body: '', action: 'draft', confidence: 0, error: 'CONFIG_ERROR', aiResult: { ...sampleRunAiError, draft: null } };
    expect(normalizeRunResult(envelope)).toBe(envelope);
    expect(normalizeRunResult(envelope)!.aiResult).toMatchObject({ draft: null });
  });

  it('원본을 최상위에 저장했던 과거 SSE 행은 읽을 때만 {aiResult}로 감싼다', () => {
    const legacy: Record<string, unknown> = { ...sampleRunAutoAnswer };
    expect(normalizeRunResult(legacy)).toEqual({ aiResult: legacy });
  });

  it('null과 원본이 아닌 기타 JSON은 그대로', () => {
    expect(normalizeRunResult(null)).toBeNull();
    const other = { reason: 'lease_expired', error: 'lease_expired' };
    expect(normalizeRunResult(other)).toBe(other);
    // 평탄 큐 형식(confidence 숫자)은 pipelineVersion·decision 문자열이 있어도 원본으로 오인해 감싸지 않는다
    const flat = { body: '', action: 'draft', decision: 'escalate', pipelineVersion: 'ai-pipeline@1', confidence: 0, error: 'CONFIG_ERROR' };
    expect(normalizeRunResult(flat)).toBe(flat);
    // 회귀: confidence가 null인 평탄 행도 원형 그대로(null은 객체로 오인하지 않음)
    const flatNull = { ...flat, confidence: null };
    expect(normalizeRunResult(flatNull)).toBe(flatNull);
  });
});
