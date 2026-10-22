/**
 * MockProvider: API 키 없이 동작하는 결정적 구현.
 * - 분류: 테넌트 설정의 카테고리 키워드 일치 수로 결정(같은 입력 → 항상 같은 출력)
 * - 생성: 근거 문서 본문을 템플릿에 끼워 넣는다(문장을 새로 지어내지 않음)
 * - 스트리밍: 생성 결과를 작은 조각으로 나눠 흘려보낸다(가짜 스트리밍)
 * 실제 LLM 보다 "말을 잘 하지는" 못한다. 시연·개발·테스트용이며 품질 평가는 AI_MODE=claude 로 한다.
 */
import type { AIUsage, ClassificationResult } from '../contracts';
import { heuristicSentiment, heuristicUrgency, scoreKeywords } from '../rules';
import { tokenize } from '../text';
import type { AIProvider, ClassifyInput, GenerateInput, ProviderResult } from './types';

export interface MockProviderOptions {
  /** 스트리밍 조각 사이 지연(ms). 테스트는 0. */
  streamDelayMs?: number;
  /** 조각 크기(문자 수) */
  chunkSize?: number;
}

const MODEL = 'mock-keyword-v1';

function usageFor(input: string, output: string): AIUsage {
  // 토큰 수는 근사치(bigram 수)로 기록한다.
  return { provider: 'mock', model: MODEL, inputTokens: tokenize(input).length, outputTokens: tokenize(output).length };
}

export class MockProvider implements AIProvider {
  readonly name = 'mock' as const;
  readonly model = MODEL;
  private readonly delay: number;
  private readonly chunkSize: number;

  constructor(options: MockProviderOptions = {}) {
    this.delay = options.streamDelayMs ?? 0;
    this.chunkSize = options.chunkSize ?? 12;
  }

  async classify({ settings, message }: ClassifyInput): Promise<ProviderResult<ClassificationResult>> {
    const scores = scoreKeywords(settings, message);
    const sentiment = heuristicSentiment(message);
    const urgency = heuristicUrgency(message, sentiment);
    const category = scores.top?.category ?? settings.fallbackCategory;
    const count = scores.top?.count ?? 0;
    const confidence = count === 0 ? 0.2 : Math.min(0.95, 0.55 + 0.15 * count);
    const label = settings.categories.find((c) => c.id === category)?.label ?? category;
    const value: ClassificationResult = {
      category,
      urgency,
      sentiment,
      confidence,
      summary: `[${label}] ${message.replace(/\s+/g, ' ').slice(0, 60)}`,
    };
    return { value, usage: usageFor(message, JSON.stringify(value)) };
  }

  private compose({ settings, articles, mode }: GenerateInput): string {
    const top = articles[0];
    if (mode === 'agent_draft') {
      const lines = ['안녕하세요, 고객님. 문의해 주셔서 감사합니다.', '말씀하신 내용은 담당 상담원이 직접 확인한 뒤 안내드리겠습니다.'];
      if (top) lines.push('', `참고로 관련 안내를 함께 드립니다.`, '', top.body);
      lines.push('', '확인되는 대로 이 문의글로 답변드리겠습니다.');
      return lines.join('\n');
    }
    if (!top) {
      return `안녕하세요, ${settings.botName}입니다. 문의하신 내용은 담당 상담원이 확인 후 안내드리겠습니다.`;
    }
    return [`안녕하세요, ${settings.botName}입니다.`, '', top.body, '', '추가로 궁금한 점이 있으면 언제든 다시 문의해 주세요.'].join('\n');
  }

  async generate(input: GenerateInput): Promise<ProviderResult<string>> {
    const text = this.compose(input);
    return { value: text, usage: usageFor(input.message, text) };
  }

  async *streamGenerate(input: GenerateInput): AsyncGenerator<string, AIUsage, void> {
    const text = this.compose(input);
    const { signal } = input;
    let sent = '';
    for (let i = 0; i < text.length; i += this.chunkSize) {
      if (this.delay > 0) await sleep(this.delay, signal);
      if (signal?.aborted) break;
      const chunk = text.slice(i, i + this.chunkSize);
      sent += chunk;
      yield chunk;
    }
    return usageFor(input.message, sent);
  }
}

/** 취소되면 즉시 끝나는 지연 */
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      signal?.removeEventListener('abort', done);
      resolve();
    }
    signal?.addEventListener('abort', done, { once: true });
  });
}
