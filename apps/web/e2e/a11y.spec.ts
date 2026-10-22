import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import type { Who } from './env';
import { contextAs, createTicket, uniq } from './helpers';

/**
 * 주요 페이지 접근성(axe: serious/critical 위반 0)과 모바일 가로 넘침 검사.
 * Lighthouse 대신 axe-core로 대체한다. 모바일 프로젝트(375px)에서는 scrollWidth <= 375도 확인한다.
 */
async function audit(page: Page, label: string, ready: () => Promise<void>) {
  await ready();
  const result = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
  const blocking = result.violations
    .filter((v) => v.impact === 'serious' || v.impact === 'critical')
    .map((v) => `${v.id}(${v.impact}): ${v.help} → ${v.nodes.map((n) => n.target.join(' ')).slice(0, 5).join(' | ')}`);
  expect(blocking, `${label} axe 위반`).toEqual([]);

  const width = page.viewportSize()?.width ?? 0;
  if (width <= 375) {
    const scrollWidth = await page.evaluate(() => document.documentElement.scrollWidth);
    expect(scrollWidth, `${label} 가로 넘침`).toBeLessThanOrEqual(width);
  }
}

test('접근성·모바일 레이아웃: 로그인, 고객 목록·상세, 대시보드 큐·상세, 설정', async ({ browser }, testInfo) => {
  test.setTimeout(180_000);
  const open = async (who: Who | null) => (await contextAs(browser, testInfo, who)).newPage();

  const anon = await open(null);
  await anon.goto('/t/pixelforge/login');
  await audit(anon, '로그인', () => expect(anon.getByRole('button', { name: '로그인' })).toBeVisible());
  await anon.context().close();

  const customer = await open('customer1');
  const title = uniq('접근성 점검 문의');
  const ticket = await createTicket(customer.context(), 'pixelforge', title, '접근성 점검용 문의 본문입니다.\n\n- 항목 하나\n- 항목 둘');
  await customer.goto('/t/pixelforge/tickets');
  await audit(customer, '고객 목록', () => expect(customer.getByTestId('ticket-row').first()).toBeVisible());
  await customer.goto(`/t/pixelforge/tickets/${ticket.id}`);
  await audit(customer, '고객 상세', () => expect(customer.getByRole('heading', { name: title })).toBeVisible());
  await customer.getByTestId('chat-open').click();
  await audit(customer, '챗봇 패널', () => expect(customer.getByTestId('chat-input')).toBeVisible());
  await customer.context().close();

  const agent = await open('agent');
  await agent.goto('/t/pixelforge/admin');
  await audit(agent, '대시보드 큐', () => expect(agent.getByTestId('queue-row').filter({ visible: true }).first()).toBeVisible());
  await agent.goto(`/t/pixelforge/admin/tickets/${ticket.id}`);
  await audit(agent, '대시보드 상세', () => expect(agent.getByRole('heading', { name: title })).toBeVisible());
  await agent.context().close();

  const admin = await open('admin');
  await admin.goto('/t/pixelforge/admin/kb');
  await audit(admin, 'KB 관리', () => expect(admin.getByRole('button', { name: '문서 만들기' })).toBeVisible());
  await admin.goto('/t/pixelforge/admin/settings');
  await audit(admin, '설정', () => expect(admin.getByRole('heading', { name: '테넌트 설정' })).toBeVisible());
  await admin.context().close();
});
