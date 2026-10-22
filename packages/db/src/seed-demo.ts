import { and, eq } from 'drizzle-orm';
import { InMemoryKbRepository, MockProvider, processInquiry } from '@support/ai';
import { toKbArticles, type TenantSeed } from '@support/ai/data';
import type { DemoCase } from '@support/ai/contracts';
import { db, tickets, ticketMessages, aiJobs, aiRuns, aiDrafts, kbArticles } from './index';
import { seedId } from './seed-id';
import { demoAccountPlans, findDemoRows } from './demo-accounts';

type Transaction = Parameters<Parameters<typeof db.transaction>[0]>[0];

export async function seedDemoTickets(tx: Transaction, tenantId: string, bundle: TenantSeed, cases: DemoCase[]): Promise<void> {
  // 시연 티켓 작성자: 공유 표의 해당 테넌트 첫 고객(전환 전 이메일 행도 같은 계정으로 인식)
  const plan = demoAccountPlans().find(p => p.tenantSlug === bundle.slug && p.role === 'customer');
  const [customer] = plan ? await findDemoRows(tx, tenantId, plan) : [];
  if (!customer) throw new Error(`Demo customer missing for ${bundle.slug}`);
  const kbRows = await tx.select({ id: kbArticles.id, slug: kbArticles.slug, sourceUrl: kbArticles.sourceUrl }).from(kbArticles).where(eq(kbArticles.tenantId, tenantId));
  const kbIds = new Map(kbRows.map(row => [row.slug, row.id]));
  const kbUrls = new Map(kbRows.map(row => [row.id, row.sourceUrl]));
  const kb = new InMemoryKbRepository(toKbArticles(tenantId, bundle.kb));
  const provider = new MockProvider(); // Seeding never calls a paid provider, even in a Claude dev environment.
  for (const demo of cases) {
    if (demo.channel !== 'ticket') continue;
    const ticketId = seedId(`demo:${bundle.slug}:${demo.key}`);
    const [created] = await tx.insert(tickets).values({ id: ticketId, tenantId, customerId: customer.id, title: demo.title, body: demo.message, idempotencyKey: `seed:${demo.key}` }).onConflictDoNothing().returning({ id: tickets.id });
    if (!created) continue; // Never overwrite a demo that a developer/customer has already edited.
    const messageId = seedId(`demo-message:${bundle.slug}:${demo.key}`);
    const jobId = seedId(`demo-job:${bundle.slug}:${demo.key}`);
    const runId = seedId(`demo-run:${bundle.slug}:${demo.key}`);
    await tx.insert(ticketMessages).values({ id: messageId, tenantId, ticketId, authorId: customer.id, role: 'customer', authorType: 'customer', body: demo.message, visibility: 'public' });
    const settings = { ...bundle.settings, ...demo.settingsOverride };
    const result = await processInquiry({ tenantId, ticketId, messageId }, {
      provider, kb,
      inquiries: { getInquiryContext: async () => ({ message: { id: messageId, body: demo.message }, autoAnswerCount: 0 }) },
      settings: { getTenantAISettings: async () => settings },
    });
    if (result.error || result.decision !== demo.expected.decision || result.reason !== demo.expected.reason || result.classification?.category !== demo.expected.category || Math.abs(result.confidence.final - demo.expected.confidence) > 0.0005) {
      throw new Error(`AI demo expectation mismatch: ${bundle.slug}/${demo.key}`);
    }
    const sources = result.sources.map(source => {
      const id = kbIds.get(source.kbArticleId);
      if (!id) throw new Error(`Demo source missing: ${bundle.slug}/${source.kbArticleId}`);
      return { ...source, kbArticleId: id };
    });
    const now = new Date();
    await tx.insert(aiJobs).values({ id: jobId, tenantId, ticketId, messageId, pipelineVersion: result.pipelineVersion, idempotencyKey: `seed:${demo.key}`, status: 'succeeded', attempts: 1 });
    await tx.insert(aiRuns).values({
      id: runId, tenantId, ticketId, jobId, messageId, status: 'succeeded',
      result: { ...result, sources, draft: result.draft ? { ...result.draft, sources } : null, demo: { key: demo.key, settingsOverride: demo.settingsOverride } },
      decision: result.decision, reason: result.reason, category: result.classification?.category,
      urgency: result.classification?.urgency, sentiment: result.classification?.sentiment,
      confidence: result.confidence.final, sources, model: result.draft?.model ?? result.usage[0]?.model,
      inputTokens: result.usage.length ? result.usage.reduce((sum, usage) => sum + usage.inputTokens, 0) : null,
      outputTokens: result.usage.length ? result.usage.reduce((sum, usage) => sum + usage.outputTokens, 0) : null,
      latencyMs: Math.round(result.timing.totalMs), pipelineVersion: result.pipelineVersion,
    });
    if (result.decision === 'auto_answer') {
      if (!result.draft) throw new Error(`Automatic demo lacks answer: ${bundle.slug}/${demo.key}`);
      const publicSources = sources.map(source => ({ id: source.kbArticleId, title: source.title, ...(source.excerpt ? { excerpt: source.excerpt } : {}), ...(kbUrls.get(source.kbArticleId) ? { url: kbUrls.get(source.kbArticleId)! } : {}) }));
      await tx.insert(ticketMessages).values({ id: seedId(`demo-answer:${bundle.slug}:${demo.key}`), tenantId, ticketId, role: 'ai', authorType: 'ai', body: result.draft.body, sources: publicSources, sourceJobId: jobId });
    } else if (result.draft) {
      await tx.insert(aiDrafts).values({ id: seedId(`demo-draft:${bundle.slug}:${demo.key}`), tenantId, ticketId, jobId, runId, body: result.draft.body, sources });
    }
    await tx.update(tickets).set({
      category: result.classification?.category, urgency: result.classification?.urgency, sentiment: result.classification?.sentiment,
      autoReplyCount: result.decision === 'auto_answer' ? 1 : 0,
      autoAnsweredAt: result.decision === 'auto_answer' ? now : null,
      escalatedAt: result.decision === 'auto_answer' ? null : now,
      escalationReason: result.decision === 'auto_answer' ? null : result.reason,
    }).where(and(eq(tickets.tenantId, tenantId), eq(tickets.id, ticketId)));
  }
}
