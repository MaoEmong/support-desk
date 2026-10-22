import { describe, expect, it } from 'vitest';
import type { SSEEvent } from '../src/contracts';
import { streamInquiry } from '../src/pipeline';
import { MockProvider } from '../src/providers/mock';
import type { AIProvider, GenerateInput } from '../src/providers/types';
import { chatInput, makeDeps } from './helpers';

const FAQ = 'PC로 하려면 사양이 얼마나 필요해요?';
const usage = { provider: 'mock' as const, model: 'probe', inputTokens: 0, outputTokens: 0 };

/** 조각 사이를 소비자가 직접 넘겨주는 provider. 취소 신호·정리(finally) 여부를 기록한다. */
function probeProvider() {
  const mock = new MockProvider();
  const state = { streamSignal: undefined as AbortSignal | undefined, generateSignal: undefined as AbortSignal | undefined, closed: false, produced: 0 };
  let release: (() => void) | undefined;
  const provider: AIProvider = {
    name: 'mock',
    model: 'probe',
    classify: (i) => mock.classify(i),
    async generate(i: GenerateInput) {
      state.generateSignal = i.signal;
      // 취소될 때까지 끝나지 않는 초안 생성
      await new Promise<void>((resolve) => i.signal?.addEventListener('abort', () => resolve(), { once: true }));
      return { value: '초안', usage };
    },
    async *streamGenerate(i: GenerateInput) {
      state.streamSignal = i.signal;
      try {
        for (let n = 0; n < 50; n++) {
          if (n > 0) await new Promise<void>((resolve) => (release = resolve));
          state.produced++;
          yield `문장 ${n}입니다. `;
        }
        return usage;
      } finally {
        state.closed = true;
      }
    },
  };
  return { provider, state, next: () => release?.() };
}

describe('streamInquiry 취소(signal)', () => {
  it('토큰 스트림 도중 취소하면 이후 token·done 이 없고 provider 가 취소·정리된다', async () => {
    const { provider, state, next } = probeProvider();
    const controller = new AbortController();
    const gen = streamInquiry(chatInput('pixelforge'), makeDeps({ slug: 'pixelforge', message: FAQ, provider }), { signal: controller.signal });
    const events: SSEEvent[] = [];
    // classified, sources, 첫 token 까지 받는다
    while (!events.some((e) => e.type === 'token')) {
      const step = await gen.next();
      if (step.done) break;
      events.push(step.value);
    }
    expect(events.map((e) => e.type)).toEqual(['classified', 'sources', 'token']);

    // 다음 조각을 기다리는 중에 취소
    const pending = gen.next();
    controller.abort();
    next(); // provider 가 깨어나도 그 조각은 나가면 안 된다
    const after: SSEEvent[] = [];
    let step = await pending;
    while (!step.done) {
      after.push(step.value);
      step = await gen.next();
    }
    expect(after).toEqual([]);
    expect(state.streamSignal?.aborted).toBe(true);
    await new Promise((r) => setTimeout(r, 0));
    expect(state.closed).toBe(true);
  });

  it('token 을 받은 직후(소비자 쪽에서) 취소해도 더 이상 token·done 이 없다', async () => {
    const { provider, state, next } = probeProvider();
    const controller = new AbortController();
    const gen = streamInquiry(chatInput('pixelforge'), makeDeps({ slug: 'pixelforge', message: FAQ, provider }), { signal: controller.signal });
    const types: string[] = [];
    for await (const ev of gen) {
      types.push(ev.type);
      if (ev.type === 'token') {
        controller.abort();
        next();
      }
    }
    expect(types.filter((t) => t === 'token')).toHaveLength(1);
    expect(types).not.toContain('done');
    expect(types).not.toContain('error');
    await new Promise((r) => setTimeout(r, 0));
    expect(state.closed).toBe(true);
    expect(state.produced).toBeLessThanOrEqual(2);
  });

  it('이관 안내 뒤 초안 생성 중 취소하면 done 이 없고 generate 에도 취소가 전달된다', async () => {
    const { provider, state } = probeProvider();
    const controller = new AbortController();
    const gen = streamInquiry(
      chatInput('pixelforge'),
      makeDeps({ slug: 'pixelforge', message: '어제 산 패키지 환불 가능해요?', provider }),
      { signal: controller.signal },
    );
    expect((await gen.next()).value).toMatchObject({ type: 'classified' });
    expect((await gen.next()).value).toMatchObject({ type: 'escalated', reason: 'forbidden_category' });
    const pending = gen.next();
    controller.abort();
    expect(await pending).toEqual({ done: true, value: undefined });
    expect(state.generateSignal?.aborted).toBe(true);
  });

  it('이미 취소된 signal 이면 아무 이벤트도 내지 않는다', async () => {
    const controller = new AbortController();
    controller.abort();
    const events: SSEEvent[] = [];
    for await (const ev of streamInquiry(chatInput('pixelforge'), makeDeps({ slug: 'pixelforge', message: FAQ }), { signal: controller.signal })) {
      events.push(ev);
    }
    expect(events).toEqual([]);
  });

  it('취소하지 않으면 signal 이 있어도 기존 순서 그대로 done 까지 간다', async () => {
    const controller = new AbortController();
    const types: string[] = [];
    for await (const ev of streamInquiry(
      chatInput('pixelforge'),
      makeDeps({ slug: 'pixelforge', message: FAQ, provider: new MockProvider({ streamDelayMs: 1 }) }),
      { signal: controller.signal },
    )) {
      types.push(ev.type);
    }
    expect(types[0]).toBe('classified');
    expect(types[1]).toBe('sources');
    expect(types.at(-1)).toBe('done');
  });

  it('MockProvider 스트림은 취소되면 지연 중에도 바로 멈춘다', async () => {
    const controller = new AbortController();
    const mock = new MockProvider({ streamDelayMs: 10_000, chunkSize: 1 });
    const settings = makeDeps({ slug: 'pixelforge', message: FAQ });
    const s = await settings.settings.getTenantAISettings('tenant-pixelforge');
    const gen = mock.streamGenerate({
      settings: s!,
      message: FAQ,
      classification: { category: 'install', urgency: 'low', sentiment: 'neutral', confidence: 0.9 },
      articles: [],
      mode: 'customer_answer',
      signal: controller.signal,
    });
    const pending = gen.next();
    controller.abort();
    const started = Date.now();
    expect((await pending).done).toBe(true);
    expect(Date.now() - started).toBeLessThan(1000);
  });
});
