import { hash } from 'bcryptjs';
import { eq } from 'drizzle-orm';
import { loadSeedBundle, loadDemoBundle } from '@support/ai/data';
import { tenantSettingsToRow } from '@support/ai';
import { db, pool, tenants, tenantSettings, users, kbArticles } from './index';
import { runMigrations } from './migrations';
import { resetE2EDatabase } from './reset';
import { seedId } from './seed-id';
import { seedDemoTickets } from './seed-demo';
import { demoAccountPlans, demoPassword, findDemoRows } from './demo-accounts';

function sourceUrl(body: string, domains: string[]): string | null {
  for (const match of body.matchAll(/https:\/\/[^\s)<>]+/g)) {
    try {
      const candidate = new URL(match[0]);
      if (domains.some(domain => candidate.hostname === domain || candidate.hostname.endsWith(`.${domain}`))) return candidate.toString();
    } catch { /* Invalid URLs are not exposed as links. */ }
  }
  return null;
}
if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required');
// 데모 계정 비밀번호: SEED_PASSWORD 우선, 없으면 demo1234. 새로 만드는 계정에만 쓰고 기존 계정 비밀번호는 바꾸지 않는다.
const password = demoPassword();
const plans = demoAccountPlans();
try {
 if (process.argv.includes('--reset')) {
  await resetE2EDatabase(process.env.DATABASE_URL);
  await runMigrations(pool);
 }
 const bundles = loadSeedBundle();
 const demos = new Map(loadDemoBundle().map(demo => [demo.tenantSlug, demo.cases]));
 const passwordHash = await hash(password, 12);
 await db.transaction(async tx => {
  for (const bundle of bundles) {
   const { slug, displayName: name, settings } = bundle;
   await tx.insert(tenants).values({ id: seedId(`tenant:${slug}`), slug, name }).onConflictDoNothing();
   const [tenant] = await tx.select().from(tenants).where(eq(tenants.slug, slug));
   if (!tenant) throw new Error(`Missing seeded tenant ${slug}`);
   await tx.insert(tenantSettings).values({ ...tenantSettingsToRow(settings), tenantId: tenant.id, displayName: name, primaryColor: slug === 'pixelforge' ? '#7c3aed' : slug === 'mailpulse' ? '#2563eb' : null }).onConflictDoNothing();
   // 공유 표(DEMO_ACCOUNTS)의 계정: 새·이전 이메일 중 하나라도 있으면 그대로 둔다(일반 재시드는 기존 비밀번호 보존)
   for (const plan of plans.filter(p => p.tenantSlug === slug)) {
    if ((await findDemoRows(tx, tenant.id, plan)).length === 0) {
     await tx.insert(users).values({ id: seedId(plan.seedKey), tenantId: tenant.id, email: plan.email, role: plan.role, status: 'active', name: plan.label, passwordHash }).onConflictDoNothing();
    }
   }
   for (const article of bundle.kb) {
    await tx.insert(kbArticles).values({ id: seedId(`kb:${slug}:${article.id}`), tenantId: tenant.id, slug: article.id, title: article.title, question: article.question, body: article.answer, category: article.category, tags: article.tags, sourceUrl: sourceUrl(article.answer, settings.allowedLinkDomains) }).onConflictDoNothing();
   }
   await seedDemoTickets(tx, tenant.id, bundle, demos.get(slug) ?? []);
  }
  for (const plan of plans.filter(p => p.tenantSlug === null)) {
   if ((await findDemoRows(tx, null, plan)).length === 0) {
    await tx.insert(users).values({ id: seedId(plan.seedKey), email: plan.email, name: plan.label, role: plan.role, status: 'active', passwordHash }).onConflictDoNothing();
   }
  }
 });
 console.log('AI dataset seed complete; existing settings, account passwords and KB edits preserved.');
} finally { await pool.end(); }
