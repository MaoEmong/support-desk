/**
 * ClaudeProvider: 공식 Anthropic SDK 사용.
 * - 분류: messages.parse + zodOutputFormat (구조화 출력, 카테고리는 테넌트 설정의 enum 으로 제한)
 * - 생성: messages.create / messages.stream
 * - 거부(stop_reason=refusal)는 ProviderRefusalError 로 올려 파이프라인이 상담원 이관한다.
 */
import Anthropic from '@anthropic-ai/sdk';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import { z } from 'zod/v4';
import type { AIUsage, ClassificationResult } from '../contracts';
import { SentimentSchema, UrgencySchema } from '../contracts';
import type { AIConfig } from '../config';
import { AIConfigError } from '../config';
import {
  classificationSystemPrompt,
  classificationUserPrompt,
  generationSystemPrompt,
  generationUserPrompt,
} from './prompts';
import type { AIProvider, ClassifyInput, GenerateInput, ProviderResult } from './types';
import { ProviderError, ProviderRefusalError } from './types';

function toUsage(model: string, usage: { input_tokens: number; output_tokens: number }): AIUsage {
  return { provider: 'claude', model, inputTokens: usage.input_tokens, outputTokens: usage.output_tokens };
}

function wrapError(err: unknown): never {
  if (err instanceof ProviderRefusalError) throw err;
  if (err instanceof Anthropic.AuthenticationError) throw new AIConfigError('ANTHROPIC_API_KEY 인증에 실패했습니다.');
  if (err instanceof Anthropic.APIError) throw new ProviderError(`Claude API 오류(${err.status ?? 'network'}): ${err.message}`, err);
  throw new ProviderError(err instanceof Error ? err.message : String(err), err);
}

export class ClaudeProvider implements AIProvider {
  readonly name = 'claude' as const;
  readonly model: string;
  private readonly client: Anthropic;

  constructor(config: AIConfig, client?: Anthropic) {
    if (config.mode !== 'claude' || !config.apiKey) {
      throw new AIConfigError('ClaudeProvider 는 AI_MODE=claude 와 ANTHROPIC_API_KEY 가 필요합니다.');
    }
    this.model = config.model;
    this.client = client ?? new Anthropic({ apiKey: config.apiKey, timeout: config.timeoutMs, maxRetries: config.maxRetries });
  }

  async classify({ settings, message, signal }: ClassifyInput): Promise<ProviderResult<ClassificationResult>> {
    const ids = settings.categories.map((c) => c.id) as [string, ...string[]];
    const schema = z.object({
      category: z.enum(ids),
      urgency: UrgencySchema,
      sentiment: SentimentSchema,
      confidence: z.number().min(0).max(1),
      summary: z.string(),
    });
    try {
      const response = await this.client.messages.parse({
        model: this.model,
        max_tokens: 2000,
        output_config: { effort: 'low', format: zodOutputFormat(schema) },
        system: classificationSystemPrompt(settings),
        messages: [{ role: 'user', content: classificationUserPrompt(message) }],
      }, { signal });
      if (response.stop_reason === 'refusal') throw new ProviderRefusalError();
      const parsed = response.parsed_output;
      if (!parsed) throw new ProviderError('분류 결과를 해석하지 못했습니다');
      return { value: { ...parsed, summary: parsed.summary.slice(0, 300) }, usage: toUsage(this.model, response.usage) };
    } catch (err) {
      wrapError(err);
    }
  }

  async generate(input: GenerateInput): Promise<ProviderResult<string>> {
    try {
      const response = await this.client.messages.create({
        model: this.model,
        max_tokens: 4000,
        output_config: { effort: 'medium' },
        system: generationSystemPrompt(input),
        messages: [{ role: 'user', content: generationUserPrompt(input) }],
      }, { signal: input.signal });
      if (response.stop_reason === 'refusal') throw new ProviderRefusalError();
      const text = response.content
        .filter((b): b is Anthropic.TextBlock => b.type === 'text')
        .map((b) => b.text)
        .join('');
      return { value: text, usage: toUsage(this.model, response.usage) };
    } catch (err) {
      wrapError(err);
    }
  }

  async *streamGenerate(input: GenerateInput): AsyncGenerator<string, AIUsage, void> {
    let stream: ReturnType<Anthropic['messages']['stream']> | undefined;
    let completed = false;
    try {
      stream = this.client.messages.stream(
        {
          model: this.model,
          max_tokens: 4000,
          output_config: { effort: 'medium' },
          system: generationSystemPrompt(input),
          messages: [{ role: 'user', content: generationUserPrompt(input) }],
        },
        { signal: input.signal },
      );
      for await (const event of stream) {
        if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
          yield event.delta.text;
        }
      }
      const final = await stream.finalMessage();
      completed = true;
      if (final.stop_reason === 'refusal') throw new ProviderRefusalError();
      return toUsage(this.model, final.usage);
    } catch (err) {
      return wrapError(err);
    } finally {
      // 소비자가 중간에 멈추면(취소·안전 검사 위반) HTTP 스트림도 닫아 토큰 비용이 더 나가지 않게 한다.
      if (!completed) stream?.abort();
    }
  }
}
