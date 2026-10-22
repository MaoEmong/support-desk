import type { TenantAISettings } from '../src/contracts';
import { loadSeedBundle, toKbArticles } from '../src/data';
import { InMemoryKbRepository } from '../src/kb/search';
import type { PipelineDeps } from '../src/pipeline';
import { MockProvider } from '../src/providers/mock';
import type { AIProvider } from '../src/providers/types';

export const seeds = loadSeedBundle();
export const tenantId = (slug: string) => `tenant-${slug}`;
export const settingsOf = (slug: string): TenantAISettings => {
  const s = seeds.find((t) => t.slug === slug);
  if (!s) throw new Error(`no tenant ${slug}`);
  return s.settings;
};

export const kb = new InMemoryKbRepository(seeds.flatMap((s) => toKbArticles(tenantId(s.slug), s.kb)));

export function makeDeps(opts: {
  slug: string;
  message: string;
  settings?: Partial<TenantAISettings>;
  provider?: AIProvider;
  autoAnswerCount?: number;
  kbRepo?: PipelineDeps['kb'];
}): PipelineDeps {
  const id = tenantId(opts.slug);
  const settings = { ...settingsOf(opts.slug), ...opts.settings };
  return {
    provider: opts.provider ?? new MockProvider(),
    kb: opts.kbRepo ?? kb,
    settings: { getTenantAISettings: async (t) => (t === id ? settings : null) },
    inquiries: {
      getInquiryContext: async (input) =>
        input.tenantId === id ? { message: { id: input.messageId, body: opts.message }, autoAnswerCount: opts.autoAnswerCount ?? 0 } : null,
    },
  };
}

export const input = (slug: string) => ({ tenantId: tenantId(slug), ticketId: 't-1', messageId: 'm-1' });
export const chatInput = (slug: string) => ({ tenantId: tenantId(slug), conversationId: 'c-1', messageId: 'm-1' });
