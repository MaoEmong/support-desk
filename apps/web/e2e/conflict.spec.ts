import { expect, test } from '@playwright/test';
import { contextAs, createTicket, uniq } from './helpers';

/**
 * 409: 같은 티켓을 상담원 화면 2개로 열고, A가 먼저 상태를 바꾼 뒤 B가 오래된 version으로 바꾸면 view-409.
 * 상세 화면은 5초마다 폴링하므로, B 화면이 "오래된 화면"으로 남도록 B의 GET 응답을 처음 받은 값으로 고정한다
 * (PATCH 요청은 그대로 서버로 보낸다).
 * 초안 승인 409는 시드에 AI 초안이 없고 dev 서버에 AI 워커가 기동되지 않아(초안 생성 불가) 이번 범위에서 생략한다.
 */
test('상태 변경 동시 수정 → 오래된 화면에서 409 안내', async ({ browser }, testInfo) => {
  const customer = await contextAs(browser, testInfo, 'customer1');
  const title = uniq('동시 수정 확인');
  const ticket = await createTicket(customer, 'pixelforge', title);
  await customer.close();

  const ctxA = await contextAs(browser, testInfo, 'agent');
  const ctxB = await contextAs(browser, testInfo, 'agent');
  const url = `/t/pixelforge/admin/tickets/${ticket.id}`;
  const apiPath = `**/api/t/pixelforge/admin/tickets/${ticket.id}`;

  const b = await ctxB.newPage();
  let stale: { body: string; headers: Record<string, string> } | null = null;
  await b.route(apiPath, async (route) => {
    if (route.request().method() !== 'GET') return route.continue();
    if (stale) return route.fulfill({ status: 200, body: stale.body, headers: stale.headers });
    const res = await route.fetch();
    // 본문은 이미 풀린 상태라 압축·길이 헤더는 버린다
    const headers = Object.fromEntries(Object.entries(res.headers()).filter(([k]) => !['content-encoding', 'content-length', 'transfer-encoding'].includes(k)));
    stale = { body: await res.text(), headers };
    return route.fulfill({ status: res.status(), body: stale.body, headers });
  });
  await b.goto(url);
  await expect(b.getByRole('heading', { name: title })).toBeVisible();

  const a = await ctxA.newPage();
  await a.goto(url);
  await expect(a.getByTestId('status-select')).toHaveValue('open');
  await a.getByTestId('status-select').selectOption('in_progress');
  await expect(a.getByTestId('status-select')).toHaveValue('in_progress');

  // B는 아직 open(version 1)을 보고 있다
  await expect(b.getByTestId('status-select')).toHaveValue('open');
  const patch = b.waitForResponse((r) => r.url().includes(`/admin/tickets/${ticket.id}`) && r.request().method() === 'PATCH');
  await b.getByTestId('status-select').selectOption('resolved');
  expect((await patch).status()).toBe(409);
  await expect(b.getByTestId('view-409')).toBeVisible();

  // 최신 내용 불러오기 → 실제 서버 상태(A의 변경) 확인
  await b.unrouteAll();
  await b.getByTestId('view-409').getByRole('button', { name: '최신 내용 불러오기' }).click();
  await expect(b.getByTestId('status-select')).toHaveValue('in_progress');

  await ctxA.close();
  await ctxB.close();
});
