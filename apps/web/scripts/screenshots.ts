/**
 * 포트폴리오 README용 스크린샷(E2E와 별개). 이미 떠 있는 서버(기본 http://127.0.0.1:3000)에 붙어서 캡처만 한다.
 * - 서버를 띄우거나 끄지 않는다. 시연 DB에 새 고객·문의·대화를 만든다(데모 문장은 @support/ai/data의 getDemoCase).
 * - 실행(apps/web): ../../node_modules/.bin/tsx scripts/screenshots.ts
 * - 출력: <repo>/docs/screenshots/*.png (데스크톱 1280×800, 모바일 375×812, deviceScaleFactor 2)
 * - dev 서버의 Next.js 개발 도구 아이콘(nextjs-portal)은 페이지마다 CSS로 숨기고, 캡처 직전에 DOM으로 확인한다.
 */
import { mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { getDemoCase } from '@support/ai/data';
import { DEMO_PASSWORD } from '../src/lib/demo-accounts';

const BASE = process.env.SCREENSHOT_BASE_URL ?? 'http://127.0.0.1:3000';
const OUT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'docs', 'screenshots');
const HIDE_DEV_TOOLS = 'nextjs-portal{display:none!important}';
const WAIT = 60_000;
const stamp = Date.now().toString(36);

type Slug = 'pixelforge' | 'mailpulse';
interface StaffTicket {
  aiRuns: { status: string; createdAt: string }[];
}

async function newContext(browser: Browser, mobile = false) {
  return browser.newContext({
    baseURL: BASE,
    viewport: mobile ? { width: 375, height: 812 } : { width: 1280, height: 800 },
    deviceScaleFactor: 2,
    isMobile: mobile,
    hasTouch: mobile,
    locale: 'ko-KR',
  });
}

/** 브라우저 컨텍스트 쿠키(세션·CSRF)로 API 호출. Origin은 서버 APP_URL과 같은 BASE */
async function call<T>(ctx: BrowserContext, method: 'GET' | 'POST', apiPath: string, body?: unknown, headers: Record<string, string> = {}): Promise<T> {
  const csrf = (await ctx.cookies(BASE)).find((c) => c.name === 'sd_csrf')?.value;
  const res = await ctx.request.fetch(`${BASE}/api${apiPath}`, {
    method,
    data: body,
    headers: { origin: BASE, ...(csrf && method !== 'GET' ? { 'x-csrf-token': csrf } : {}), ...headers },
  });
  if (!res.ok()) throw new Error(`${method} ${apiPath} → ${res.status()} ${(await res.text()).slice(0, 300)}`);
  return (await res.json()) as T;
}

async function loginAs(ctx: BrowserContext, slug: Slug, email: string) {
  await call(ctx, 'POST', `/t/${slug}/auth/login`, { email, password: DEMO_PASSWORD });
}

async function signupCustomer(ctx: BrowserContext, slug: Slug, name: string) {
  const email = `shot-${stamp}-${Math.random().toString(36).slice(2, 6)}@example.test`;
  await call(ctx, 'POST', `/t/${slug}/auth/signup`, { name, email, password: DEMO_PASSWORD });
  return email;
}

async function createTicket(ctx: BrowserContext, slug: Slug, key: string) {
  const item = getDemoCase(slug, key);
  const t = await call<{ id: string }>(ctx, 'POST', `/t/${slug}/tickets`, { title: item.title, body: item.message }, { 'idempotency-key': `shot-${stamp}-${key}` });
  return { id: t.id, item };
}

/** 워커 처리 완료(최신 aiRun succeeded/failed)를 상담원 API로 기다린다 */
async function waitWorker(staff: BrowserContext, slug: Slug, id: string) {
  const deadline = Date.now() + WAIT;
  while (Date.now() < deadline) {
    const t = await call<StaffTicket>(staff, 'GET', `/t/${slug}/admin/tickets/${id}`);
    const run = [...t.aiRuns].sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
    if (run && (run.status === 'succeeded' || run.status === 'failed')) return run.status;
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`워커 처리 대기 시간 초과: ${slug}/${id}`);
}

const shots: string[] = [];
async function shot(page: Page, name: string, fullPage = false) {
  await page.addStyleTag({ content: HIDE_DEV_TOOLS });
  await page.evaluate(() => document.fonts.ready);
  const devToolsVisible = await page.evaluate(() =>
    Array.from(document.querySelectorAll('nextjs-portal')).some((el) => getComputedStyle(el).display !== 'none'),
  );
  if (devToolsVisible) throw new Error(`${name}: Next.js 개발 도구 아이콘이 보입니다.`);
  const file = path.join(OUT, `${name}.png`);
  await page.screenshot({ path: file, fullPage });
  shots.push(`${name}.png${fullPage ? ' (full page)' : ''}`);
  console.log(`saved ${name}.png`);
}

async function sendChat(page: Page, slug: Slug, key: string) {
  const item = getDemoCase(slug, key);
  await page.goto(`/t/${slug}/tickets`);
  await page.getByTestId('chat-open').click();
  await page.getByTestId('chat-input').fill(item.message);
  await page.getByTestId('chat-send').click();
  // 스트리밍 종료: 중단 버튼이 사라지고 전송 버튼이 돌아온다
  await page.getByTestId('chat-send').waitFor({ timeout: WAIT });
}

async function main() {
  // 이전 실행의 캡처가 섞이지 않도록 png를 비우고 시작한다
  rmSync(OUT, { recursive: true, force: true });
  mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch();
  try {
    const admin = await newContext(browser);
    await loginAs(admin, 'pixelforge', 'admin@pf.test');

    // ── 데이터 준비: 새 고객의 문의 3건(FAQ 자동답변·환불 이관·해킹 이관) ──
    const customer = await newContext(browser);
    const customerEmail = await signupCustomer(customer, 'pixelforge', '김하늘');
    const faq = await createTicket(customer, 'pixelforge', 'faq_install');
    const refund = await createTicket(customer, 'pixelforge', 'refund_escalate');
    const hacking = await createTicket(customer, 'pixelforge', 'hacking_escalate');
    for (const t of [faq, refund, hacking]) console.log(`${t.item.key}: ${await waitWorker(admin, 'pixelforge', t.id)}`);

    const mpAdmin = await newContext(browser);
    await loginAs(mpAdmin, 'mailpulse', 'admin@mp.test');
    const mpCustomer = await newContext(browser);
    await signupCustomer(mpCustomer, 'mailpulse', '이도윤');
    const campaign = await createTicket(mpCustomer, 'mailpulse', 'faq_campaign');
    console.log(`faq_campaign: ${await waitWorker(mpAdmin, 'mailpulse', campaign.id)}`);

    // ── 고객 화면 ──
    const page = await customer.newPage();
    await page.goto('/t/pixelforge/tickets');
    await page.getByTestId('ticket-row').nth(2).waitFor();
    await shot(page, '01-customer-tickets');

    // 자동답변(근거 포함)이 나오면 02-ai-answer, 이관되면 고객 상세의 접수·확인 중 화면(02-customer-ticket)으로 찍는다.
    // 시연 DB 설정에 따라 FAQ가 이관될 수 있어 결과를 그대로 기록한다(README에 명시).
    await page.goto(`/t/pixelforge/tickets/${faq.id}`);
    const aiAnswer = page.locator('[data-testid="message"][data-author-type="ai"]').getByTestId('message-sources');
    const answered = await aiAnswer.waitFor({ timeout: 8_000 }).then(() => true, () => false);
    await shot(page, answered ? '02-ai-answer' : '02-customer-ticket', true);

    // 챗봇: 탭마다 sessionStorage가 달라 새 탭이면 새 대화다. FAQ 답변이 나오면 03-chatbot-faq, 이관이면 기록만 한다.
    const chatFaq = await customer.newPage();
    await sendChat(chatFaq, 'pixelforge', 'chat_faq');
    const faqSources = chatFaq.locator('[data-testid="chat-message"][data-role="assistant"]').getByTestId('message-sources');
    const faqResult = await Promise.race([
      faqSources.waitFor({ timeout: WAIT }).then(() => 'answer' as const),
      chatFaq.getByTestId('chat-escalated').waitFor({ timeout: WAIT }).then(() => 'escalated' as const),
    ]);
    console.log(`chat_faq: ${faqResult}`);
    if (faqResult === 'answer') await shot(chatFaq, '03-chatbot-faq');

    const chatHack = await customer.newPage();
    await sendChat(chatHack, 'pixelforge', 'chat_hacking');
    await chatHack.getByTestId('chat-escalated').waitFor({ timeout: WAIT });
    await shot(chatHack, '04-chatbot-escalated');

    // ── 관리자 화면 ──
    const ap = await admin.newPage();
    await ap.goto('/t/pixelforge/admin');
    await ap.getByTestId('queue-row').filter({ visible: true }).first().waitFor();
    await shot(ap, '05-admin-queue');

    await ap.goto(`/t/pixelforge/admin/tickets/${refund.id}`);
    await ap.getByTestId('draft-approve').first().waitFor({ timeout: WAIT });
    await shot(ap, '06-admin-draft', true);

    await ap.goto('/t/pixelforge/admin/metrics');
    await ap.getByTestId('kpi-auto-resolution').waitFor();
    await shot(ap, '07-kpi', true);

    await ap.goto('/t/pixelforge/admin/settings');
    await ap.getByRole('heading', { name: 'AI 설정' }).waitFor();
    await shot(ap, '08-ai-settings', true);

    // ── 두 테넌트 브랜딩: 같은 첫 화면, 설정값만 다르다 ──
    const anon = await newContext(browser);
    const lp = await anon.newPage();
    for (const slug of ['pixelforge', 'mailpulse'] as const) {
      await lp.goto(`/t/${slug}`);
      await lp.getByTestId('tenant-name').waitFor();
      await shot(lp, `09-tenant-${slug}`);
    }

    // ── 모바일 375px ──
    const mobile = await newContext(browser, true);
    await loginAs(mobile, 'pixelforge', customerEmail);
    const mp = await mobile.newPage();
    await mp.goto(`/t/pixelforge/tickets/${refund.id}`);
    await mp.getByTestId('ticket-status').waitFor({ timeout: WAIT });
    await shot(mp, '10-mobile-ticket');
    const mchat = await mobile.newPage();
    await sendChat(mchat, 'pixelforge', 'chat_hacking');
    await mchat.getByTestId('chat-escalated').waitFor({ timeout: WAIT });
    await shot(mchat, '10-mobile-chatbot');

    console.log(JSON.stringify({ out: 'docs/screenshots', shots, data: { pixelforgeCustomer: customerEmail, tickets: [faq, refund, hacking, campaign].map((t) => t.item.key) } }, null, 1));
  } finally {
    await browser.close();
  }
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
