import { expect, test } from '@playwright/test';
import { getDemoCase } from '@support/ai/data';
import type { StaffTicketDetail } from '../src/lib/types';
import { ACCOUNTS, PASSWORD } from './env';
import { apiAs, contextAs, createTicket, uniq } from './helpers';

test('KB 만들기 다이얼로그: Esc·저장 후 트리거로 포커스 복귀, 결과 안내 role=status', async ({ browser }, testInfo) => {
  const ctx = await contextAs(browser, testInfo, 'admin');
  const page = await ctx.newPage();
  await page.goto('/t/pixelforge/admin/kb');
  const createButton = page.getByRole('button', { name: '문서 만들기' });
  await expect(createButton).toBeVisible();

  // Esc로 닫기 → 트리거로 포커스 복귀
  await createButton.click();
  await expect(page.getByRole('dialog', { name: '지식 만들기' })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(createButton).toBeFocused();

  // 저장 → 다이얼로그 닫힘, 결과 안내, 포커스 복귀
  const title = uniq('E2E 지식 문서');
  await createButton.click();
  const dialog = page.getByRole('dialog', { name: '지식 만들기' });
  await dialog.getByLabel('제목').fill(title);
  await dialog.getByLabel('본문').fill('E2E에서 만든 임시 문서입니다.');
  await dialog.getByRole('button', { name: '저장' }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.getByRole('status').filter({ hasText: '문서를 만들었습니다.' })).toBeVisible();
  await expect(createButton).toBeFocused();
  const heading = page.getByRole('heading', { name: title });
  await expect(heading).toBeVisible();

  // 정리: 방금 만든 문서 삭제 → 결과 안내
  const card = page.locator('div').filter({ has: heading }).filter({ has: page.getByRole('button', { name: '삭제' }) }).last();
  await card.getByRole('button', { name: '삭제' }).click();
  await page.getByRole('dialog', { name: '지식을 삭제하시겠습니까?' }).getByRole('button', { name: '삭제 확정' }).click();
  await expect(page.getByRole('status').filter({ hasText: '문서를 삭제했습니다.' })).toBeVisible();
  await expect(heading).toHaveCount(0);
  await ctx.close();
});

test('정상 로그아웃: 로그인 화면으로 이동, 실패 안내 없음, 보호 화면 재접근 시 로그인', async ({ browser }, testInfo) => {
  for (const [who, home] of [
    ['customer2', '/t/pixelforge/tickets'],
    ['agent', '/t/pixelforge/admin'],
  ] as const) {
    // 공유 storageState 세션을 폐기하지 않도록 새로 로그인한 세션으로 검사한다
    const ctx = await contextAs(browser, testInfo, null);
    const page = await ctx.newPage();
    await page.goto('/t/pixelforge/login');
    await page.getByLabel('이메일').fill(ACCOUNTS[who].email);
    await page.getByLabel('비밀번호').fill(PASSWORD);
    await page.getByRole('button', { name: '로그인' }).click();
    await expect(page).toHaveURL(new RegExp(`${home}$`));

    await page.getByRole('button', { name: '로그아웃' }).filter({ visible: true }).first().click();
    await expect(page).toHaveURL(/\/t\/pixelforge\/login$/);
    await expect(page.getByText('로그아웃하지 못했습니다')).toHaveCount(0);

    await page.goto(home);
    await expect(page).toHaveURL(/\/t\/pixelforge\/login\?next=/);
    await ctx.close();
  }
});

test('초안 없는 티켓의 상담원 상세: h1 1개, 오류·409 없음', async ({ browser }, testInfo) => {
  // 실제 워커가 돌면 일반 문의는 AI 처리 후 초안이 생긴다. 초안을 만들지 않는 FAQ 자동답변(faq_install) 티켓을 쓰고,
  // 처리가 끝나 초안 0건인 것을 API로 확인한 뒤 화면을 본다.
  const item = getDemoCase('pixelforge', 'faq_install');
  const customer = await contextAs(browser, testInfo, 'customer1');
  const title = uniq(item.title);
  const ticket = await createTicket(customer, 'pixelforge', title, item.message);
  await customer.close();

  const ctx = await contextAs(browser, testInfo, 'agent');
  await expect
    .poll(
      async () => {
        const detail = await apiAs<StaffTicketDetail>(ctx, 'GET', `/t/pixelforge/admin/tickets/${ticket.id}`);
        const run = [...detail.aiRuns].sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
        return { run: run?.status ?? null, decision: run?.decision ?? null, drafts: detail.drafts.length };
      },
      { timeout: 30_000, message: '워커 자동답변 처리 완료(초안 없음) 대기' },
    )
    .toEqual({ run: 'succeeded', decision: 'auto_answer', drafts: 0 });
  const page = await ctx.newPage();
  await page.goto(`/t/pixelforge/admin/tickets/${ticket.id}`);
  await expect(page.getByRole('heading', { name: title, level: 1 })).toBeVisible();
  await expect(page.getByRole('heading', { level: 1 })).toHaveCount(1);
  await expect(page.getByTestId('draft-approve')).toHaveCount(0);
  await expect(page.getByTestId('status-select')).toHaveValue('open');
  await expect(page.getByTestId('view-error')).toHaveCount(0);
  await expect(page.getByTestId('view-409')).toHaveCount(0);
  // Next.js 라우트 안내 요소(내용 없는 role=alert)는 제외하고, 내용이 있는 오류 안내만 센다
  await expect(page.getByRole('alert').filter({ hasText: /\S/ })).toHaveCount(0);
  await ctx.close();
});
