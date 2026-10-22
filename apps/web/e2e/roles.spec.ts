import { expect, test } from '@playwright/test';
import { ACCOUNTS, PASSWORD } from './env';
import { contextAs } from './helpers';

const adminNav = (page: import('@playwright/test').Page) => page.getByRole('navigation', { name: '관리 메뉴' });

test('고객은 대시보드 접근 시 403', async ({ browser }, testInfo) => {
  const ctx = await contextAs(browser, testInfo, 'customer1');
  const page = await ctx.newPage();
  await page.goto('/t/pixelforge/admin');
  await expect(page.getByTestId('view-403')).toBeVisible();
  await expect(adminNav(page)).toHaveCount(0);
  await ctx.close();
});

test('상담원: 설정 메뉴 없음, 설정 라우트 403, Mock 배지 표시', async ({ browser }, testInfo) => {
  const ctx = await contextAs(browser, testInfo, 'agent');
  const page = await ctx.newPage();
  await page.goto('/t/pixelforge/admin');
  await expect(adminNav(page).getByRole('link', { name: '티켓 큐' })).toBeVisible();
  await expect(adminNav(page).getByRole('link', { name: '설정' })).toHaveCount(0);
  await expect(page.getByTestId('mock-badge')).toBeVisible();

  await page.goto('/t/pixelforge/admin/settings');
  await expect(page.getByTestId('view-403')).toBeVisible();
  await expect(page.getByRole('heading', { name: '테넌트 설정' })).toHaveCount(0);
  await ctx.close();
});

test('테넌트 관리자: 설정 메뉴로 설정 화면 진입', async ({ browser }, testInfo) => {
  const ctx = await contextAs(browser, testInfo, 'admin');
  const page = await ctx.newPage();
  await page.goto('/t/pixelforge/admin');
  const link = adminNav(page).getByRole('link', { name: '설정' });
  await expect(link).toBeVisible();
  await link.click();
  await expect(page).toHaveURL(/\/t\/pixelforge\/admin\/settings$/);
  await expect(page.getByRole('heading', { name: '테넌트 설정' })).toBeVisible();
  await expect(page.getByLabel('챗봇 이름')).not.toHaveValue('');
  await ctx.close();
});

test('로그인 폼: 역할별 첫 화면(고객 → 내 문의, 상담원 → 대시보드)', async ({ browser }, testInfo) => {
  for (const [who, landing] of [
    ['customer2', /\/t\/pixelforge\/tickets$/],
    ['agent', /\/t\/pixelforge\/admin$/],
  ] as const) {
    const ctx = await contextAs(browser, testInfo, null);
    const page = await ctx.newPage();
    await page.goto('/t/pixelforge/login');
    await page.getByLabel('이메일').fill(ACCOUNTS[who].email);
    await page.getByLabel('비밀번호').fill(PASSWORD);
    await page.getByRole('button', { name: '로그인' }).click();
    await expect(page).toHaveURL(landing);
    await ctx.close();
  }
});

test('미로그인으로 내 문의 접근 → 로그인 화면', async ({ browser }, testInfo) => {
  const ctx = await contextAs(browser, testInfo, null);
  const page = await ctx.newPage();
  await page.goto('/t/pixelforge/tickets');
  await expect(page).toHaveURL(/\/t\/pixelforge\/login\?next=%2Ft%2Fpixelforge%2Ftickets/);
  await expect(page.getByRole('heading', { name: '로그인' })).toBeVisible();
  await ctx.close();
});

test('플랫폼 관리자: 테넌트 2개와 집계만, 티켓 화면·본문 API 없음', async ({ browser }, testInfo) => {
  const ctx = await contextAs(browser, testInfo, 'platform');
  const page = await ctx.newPage();
  await page.goto('/platform');
  await expect(page.getByRole('heading', { name: '플랫폼 관리' })).toBeVisible();
  await expect(page.getByTestId('platform-tenant')).toHaveCount(2);
  await expect(page.getByTestId('platform-tenant').filter({ hasText: '/t/pixelforge' })).toBeVisible();
  await expect(page.getByTestId('platform-tenant').filter({ hasText: '/t/mailpulse' })).toBeVisible();
  await expect(page.locator('a[href*="/tickets"]')).toHaveCount(0);

  // 플랫폼 세션으로는 테넌트 티켓 API에 접근할 수 없다
  const res = await ctx.request.get('/api/t/pixelforge/admin/tickets');
  expect(res.status()).toBe(401);
  await ctx.close();
});
