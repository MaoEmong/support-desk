import type { AIConfig } from '../config';
import { loadAIConfig } from '../config';
import { ClaudeProvider } from './claude';
import { MockProvider, type MockProviderOptions } from './mock';
import type { AIProvider } from './types';

export * from './types';
export { ClaudeProvider } from './claude';
export { MockProvider, type MockProviderOptions } from './mock';

/** 설정에 맞는 Provider 생성. config 를 생략하면 환경변수에서 읽는다(AI_MODE 필수). */
export function createProvider(config: AIConfig = loadAIConfig(), mockOptions?: MockProviderOptions): AIProvider {
  return config.mode === 'claude' ? new ClaudeProvider(config) : new MockProvider(mockOptions);
}
