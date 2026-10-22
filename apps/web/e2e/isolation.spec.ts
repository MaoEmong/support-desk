import { expect, test } from '@playwright/test';
import { ACCOUNTS, PASSWORD } from './env';
import { contextAs, createTicket, uniq } from './helpers';

test('다른 고객 티켓 URL 직접 접근 → 404 화면', async ({ browser }, testInfo) => {
  const owner = await contextAs(browser, testInfo, 'customer1');
  const other = await contextAs(browser, testInfo, 'customer2');
  const title = uniq('customer1 비공개 문의');
  const ticket = await createTicket(owner, 'pixelforge', title);

  const page = await other.newPage();
  await page.goto(`/t/pixelforge/tickets/${ticket.id}`);
  await expect(page.getByTestId('view-404')).toBeVisible();
  await expect(page.getByText(title)).toHaveCount(0);

  // 본인은 정상 조회
  const mine = await owner.newPage();
  await mine.goto(`/t/pixelforge/tickets/${ticket.id}`);
  await expect(mine.getByRole('heading', { name: title })).toBeVisible();

  await owner.close();
  await other.close();
});

test('교차 테넌트: pixelforge 세션으로 mailpulse 접근 차단, pixelforge 계정으로 mailpulse 로그인 실패', async ({ browser }, testInfo) => {
  const ctx = await contextAs(browser, testInfo, 'customer1');
  const title = uniq('pixelforge 전용 문의');
  await createTicket(ctx, 'pixelforge', title);

  const page = await ctx.newPage();
  const ticketApi: string[] = [];
  page.on('response', (r) => {
    if (r.url().includes('/api/t/mailpulse/tickets')) ticketApi.push(`${r.status()} ${r.url()}`);
  });
  await page.goto('/t/mailpulse/tickets');
  await expect(page).toHaveURL(/\/t\/mailpulse\/login\?next=/);
  await expect(page.getByRole('heading', { name: '로그인' })).toBeVisible();
  await expect(page.getByTestId('ticket-row')).toHaveCount(0);
  await expect(page.getByText(title)).toHaveCount(0);
  // 티켓 목록 API는 호출되지 않거나 401이어야 한다(데이터 미노출)
  for (const r of ticketApi) expect(r).toMatch(/^401 /);

  // pixelforge 계정 이메일로 mailpulse 로그인 → 실패
  await page.getByLabel('이메일').fill(ACCOUNTS.customer1.email);
  await page.getByLabel('비밀번호').fill(PASSWORD);
  await page.getByRole('button', { name: '로그인' }).click();
  await expect(page.getByRole('alert').filter({ hasText: '이메일 또는 비밀번호가 올바르지 않습니다' })).toBeVisible();
  await expect(page).toHaveURL(/\/t\/mailpulse\/login/);

  // 원래 pixelforge 세션은 그대로 유효
  await page.goto('/t/pixelforge/tickets');
  await expect(page.getByTestId('ticket-row').filter({ hasText: title })).toBeVisible();
  await ctx.close();
});
