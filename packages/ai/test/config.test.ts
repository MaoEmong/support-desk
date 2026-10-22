import { describe, expect, it } from 'vitest';
import { AIConfigError, DEFAULT_CLAUDE_MODEL, loadAIConfig } from '../src/config';
import { ClaudeProvider, createProvider, MockProvider } from '../src/providers';

describe('loadAIConfig', () => {
  it('AI_MODE 가 없으면 설정 오류(조용히 mock 으로 가지 않는다)', () => {
    expect(() => loadAIConfig({})).toThrow(AIConfigError);
  });

  it('알 수 없는 모드는 설정 오류', () => {
    expect(() => loadAIConfig({ AI_MODE: 'gpt' })).toThrow(/AI_MODE/);
  });

  it('mock 은 키 없이 동작한다', () => {
    const cfg = loadAIConfig({ AI_MODE: 'mock' });
    expect(cfg.mode).toBe('mock');
    expect(createProvider(cfg)).toBeInstanceOf(MockProvider);
  });

  it('claude 인데 키가 없으면 명확한 설정 오류', () => {
    expect(() => loadAIConfig({ AI_MODE: 'claude' })).toThrow(/ANTHROPIC_API_KEY/);
    expect(() => loadAIConfig({ AI_MODE: 'claude', ANTHROPIC_API_KEY: '   ' })).toThrow(AIConfigError);
  });

  it('claude + 키 → 기본 모델, AI_MODEL 로 교체 가능', () => {
    const cfg = loadAIConfig({ AI_MODE: 'claude', ANTHROPIC_API_KEY: 'sk-test' });
    expect(cfg.model).toBe(DEFAULT_CLAUDE_MODEL);
    expect(createProvider(cfg)).toBeInstanceOf(ClaudeProvider);
    expect(loadAIConfig({ AI_MODE: 'claude', ANTHROPIC_API_KEY: 'sk-test', AI_MODEL: 'claude-sonnet-5-5' }).model).toBe('claude-sonnet-5-5');
  });

  it('ClaudeProvider 를 mock 설정으로 만들면 오류', () => {
    expect(() => new ClaudeProvider(loadAIConfig({ AI_MODE: 'mock' }))).toThrow(AIConfigError);
  });
});
