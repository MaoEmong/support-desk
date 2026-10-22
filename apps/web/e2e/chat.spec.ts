import { expect, test } from '@playwright/test';
import { contextAs, uniq } from './helpers';

test('챗봇: 질문 → 이관 안내(스텁) → 문의글 전환 → 티켓 상세', async ({ browser }, testInfo) => {
  const ctx = await contextAs(browser, testInfo, 'customer1');
  const page = await ctx.newPage();
  await page.goto('/t/pixelforge/tickets');

  await page.getByTestId('chat-open').click();
  const panel = page.getByRole('dialog', { name: /.+/ }).filter({ has: page.getByTestId('chat-input') });
  await expect(panel).toBeVisible();
  await expect(page.getByTestId('chat-input')).toBeFocused();

  const question = `${uniq('환불 문의')} 결제를 취소하고 싶어요`;
  await page.getByTestId('chat-input').fill(question);
  await page.getByTestId('chat-send').click();
  await expect(page.getByTestId('chat-message').filter({ hasText: question })).toBeVisible();
  await expect(page.getByTestId('chat-escalated')).toBeVisible();
  await expect(page.getByTestId('chat-stop')).toHaveCount(0);

  await page.getByTestId('chat-convert').click();
  const titleInput = page.getByLabel('문의 제목');
  await expect(titleInput).toHaveValue(/환불 문의/);
  await page.getByTestId('chat-convert-submit').click();

  await expect(page).toHaveURL(/\/t\/pixelforge\/tickets\/[0-9a-f-]{36}$/);
  await expect(page.getByTestId('message').first()).toContainText(question);
  await expect(page.getByTestId('ticket-status')).toBeVisible();

  // 위젯을 다시 열면 전환된 대화로 표시(새 대화 시작 가능)
  await page.getByTestId('chat-open').click();
  await expect(page.getByTestId('chat-closed')).toContainText('문의글로 전환되었습니다');
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('chat-open')).toBeFocused();
  await ctx.close();
});
