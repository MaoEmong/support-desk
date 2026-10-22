import { expect, test } from '@playwright/test';
import { PASSWORD } from './env';
import { contextAs, uniq } from './helpers';

const SLUG = 'pixelforge';

test('고객 핵심 흐름: 가입 → 문의 → 상담원 답변 폴링 반영 → 해결 확인', async ({ browser }, testInfo) => {
  const customer = await contextAs(browser, testInfo, null);
  const agent = await contextAs(browser, testInfo, 'agent');
  const page = await customer.newPage();
  const email = `${uniq('e2e')}@example.test`;
  const title = uniq('결제 후 아이템 미지급');

  // 가입(고유 이메일) → 로그인 상태로 내 문의 화면
  await page.goto(`/t/${SLUG}/signup`);
  await page.getByLabel('이름').fill('E2E 고객');
  await page.getByLabel('이메일').fill(email);
  await page.getByLabel('비밀번호').fill(PASSWORD);
  await page.getByRole('button', { name: '가입하기' }).click();
  await expect(page).toHaveURL(new RegExp(`/t/${SLUG}/tickets$`));
  await expect(page.getByRole('heading', { name: '내 문의' })).toBeVisible();
  await expect(page.getByText('아직 남긴 문의가 없습니다')).toBeVisible();

  // 문의 작성 → 상세
  await page.getByRole('link', { name: '문의하기' }).first().click();
  await page.getByLabel('제목').fill(title);
  await page.getByLabel('내용').fill('어제 결제했는데 아이템이 들어오지 않았어요.');
  await page.getByRole('button', { name: '문의 등록' }).click();
  await expect(page).toHaveURL(new RegExp(`/t/${SLUG}/tickets/[0-9a-f-]{36}$`));
  await expect(page.getByRole('heading', { name: title })).toBeVisible();
  await expect(page.getByTestId('ticket-status')).toHaveText('접수됨');
  await expect(page.getByTestId('message')).toHaveCount(1);

  // 상담원: 큐에서 해당 티켓을 찾아 공개 답변
  const staff = await agent.newPage();
  await staff.goto(`/t/${SLUG}/admin`);
  const row = staff.getByTestId('queue-row').filter({ visible: true }).filter({ hasText: title });
  await row.getByRole('link', { name: title }).click();
  await expect(staff.getByRole('heading', { name: title })).toBeVisible();
  const reply = `안녕하세요. ${uniq('지급 완료')} 처리했습니다.`;
  await staff.getByTestId('visibility-public').click();
  await staff.getByTestId('staff-reply-input').fill(reply);
  await staff.getByTestId('staff-reply-submit').click();
  await expect(staff.getByText(reply)).toBeVisible();

  // 고객 화면: 새로고침 없이 폴링으로 답변 표시
  const agentMessage = page.getByTestId('message').filter({ hasText: reply });
  await expect(agentMessage).toBeVisible({ timeout: 20_000 });
  await expect(agentMessage).toHaveAttribute('data-author-type', 'agent');
  await expect(page.getByTestId('ticket-status')).not.toHaveText('접수됨');

  // 해결 확인
  await page.getByTestId('confirm-resolved').click();
  await page.getByTestId('confirm-resolved-submit').click();
  await expect(page.getByTestId('ticket-status')).toHaveText('해결됨');
  await expect(page.getByTestId('confirm-resolved')).toHaveCount(0);

  // 목록에도 반영
  await page.goto(`/t/${SLUG}/tickets`);
  await expect(page.getByTestId('ticket-row').filter({ hasText: title }).getByTestId('ticket-status')).toHaveText('해결됨');

  await customer.close();
  await agent.close();
});
