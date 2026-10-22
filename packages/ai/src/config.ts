/**
 * AI 실행 설정. AI_MODE 를 명시적으로 고른다(조용한 mock 전환 없음).
 *   AI_MODE=mock    → 키 없이 결정적 mock 으로 동작
 *   AI_MODE=claude  → ANTHROPIC_API_KEY 필수. 없으면 AIConfigError
 *   AI_MODEL        → 기본 claude-opus-5-5
 */

export const DEFAULT_CLAUDE_MODEL = 'claude-opus-5-5';

export type AIMode = 'mock' | 'claude';

export interface AIConfig {
  mode: AIMode;
  model: string;
  apiKey?: string;
  /** 요청 타임아웃(ms) */
  timeoutMs: number;
  maxRetries: number;
}

export class AIConfigError extends Error {
  readonly code = 'CONFIG_ERROR' as const;
  constructor(message: string) {
    super(message);
    this.name = 'AIConfigError';
  }
}

export function loadAIConfig(env: Record<string, string | undefined> = process.env): AIConfig {
  // 소비 측 noPropertyAccessFromIndexSignature 에서도 컴파일되도록 대괄호로 읽는다.
  const rawMode = env['AI_MODE']?.trim().toLowerCase();
  if (!rawMode) {
    throw new AIConfigError('AI_MODE 가 설정되지 않았습니다. AI_MODE=mock 또는 AI_MODE=claude 로 명시하세요.');
  }
  if (rawMode !== 'mock' && rawMode !== 'claude') {
    throw new AIConfigError(`AI_MODE 값이 올바르지 않습니다: "${rawMode}" (mock | claude)`);
  }
  const timeoutMs = Number(env['AI_TIMEOUT_MS'] ?? 60_000);
  const maxRetries = Number(env['AI_MAX_RETRIES'] ?? 2);
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new AIConfigError('AI_TIMEOUT_MS 는 양수여야 합니다.');
  if (!Number.isInteger(maxRetries) || maxRetries < 0) throw new AIConfigError('AI_MAX_RETRIES 는 0 이상의 정수여야 합니다.');

  if (rawMode === 'mock') {
    return { mode: 'mock', model: 'mock-keyword-v1', timeoutMs, maxRetries };
  }
  const apiKey = env['ANTHROPIC_API_KEY']?.trim();
  if (!apiKey) {
    throw new AIConfigError('AI_MODE=claude 인데 ANTHROPIC_API_KEY 가 없습니다. 키를 설정하거나 AI_MODE=mock 을 사용하세요.');
  }
  const model = env['AI_MODEL']?.trim() || DEFAULT_CLAUDE_MODEL;
  return { mode: 'claude', model, apiKey, timeoutMs, maxRetries };
}
