import type { AIUsage, ClassificationResult, TenantAISettings } from '../contracts';
import type { KbArticle } from '../kb/search';

export interface ClassifyInput {
  settings: TenantAISettings;
  message: string;
  /** 호출 취소(고객 연결 종료 등). 구현체는 진행 중인 요청을 중단해야 한다. */
  signal?: AbortSignal;
}

export type GenerateMode =
  /** 고객에게 바로 나갈 수 있는 답변(자동답변·승인 대기) */
  | 'customer_answer'
  /** 상담원 검토용 초안(이관 건). 고객에게 직접 노출되지 않는다. */
  | 'agent_draft';

export interface GenerateInput {
  settings: TenantAISettings;
  message: string;
  classification: ClassificationResult;
  articles: KbArticle[];
  mode: GenerateMode;
  /** 호출 취소. 스트리밍 구현체는 취소되면 더 이상 조각을 내지 않고 상위 스트림을 닫아야 한다. */
  signal?: AbortSignal;
}

export interface ProviderResult<T> {
  value: T;
  usage: AIUsage;
}

export interface AIProvider {
  readonly name: 'mock' | 'claude';
  readonly model: string;
  classify(input: ClassifyInput): Promise<ProviderResult<ClassificationResult>>;
  generate(input: GenerateInput): Promise<ProviderResult<string>>;
  /** 텍스트 조각을 yield 하고, 끝나면 usage 를 반환한다. */
  streamGenerate(input: GenerateInput): AsyncGenerator<string, AIUsage, void>;
}

export class ProviderRefusalError extends Error {
  readonly code = 'PROVIDER_REFUSAL' as const;
  constructor(message = '모델이 응답을 거부했습니다') {
    super(message);
    this.name = 'ProviderRefusalError';
  }
}

export class ProviderError extends Error {
  readonly code = 'PROVIDER_ERROR' as const;
  constructor(message: string, override readonly cause?: unknown) {
    super(message);
    this.name = 'ProviderError';
  }
}
