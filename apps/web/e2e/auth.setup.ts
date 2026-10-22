import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { expect, test as setup } from '@playwright/test';
import { ACCOUNTS, authFile, type Who } from './env';
import { apiLogin } from './helpers';

/** 데모 계정마다 1회만 로그인해 storageState로 저장한다(테스트마다 로그인하지 않는다). */
for (const who of Object.keys(ACCOUNTS) as Who[]) {
  setup(`login ${who}`, async ({ playwright, baseURL }) => {
    const request = await playwright.request.newContext({ baseURL });
    await apiLogin(request, who);
    mkdirSync(path.dirname(authFile(who)), { recursive: true });
    await request.storageState({ path: authFile(who) });
    await request.dispose();
  });
}

/**
 * next dev는 라우트를 처음 요청받을 때 컴파일한다(라우트당 수 초~15초).
 * 테스트의 expect 제한 시간이 컴파일 시간에 잡아먹히지 않도록 모든 화면을 한 번씩 미리 연다.
 */
const WARM: { who: Who | null; paths: string[] }[] = [
  { who: null, paths: ['/t/pixelforge', '/t/pixelforge/login', '/t/pixelforge/signup', '/platform/login'] },
  { who: 'customer1', paths: ['/t/pixelforge/tickets', '/t/pixelforge/tickets/new', '/t/pixelforge/tickets/00000000-0000-4000-8000-000000000000'] },
  { who: 'admin', paths: ['/t/pixelforge/admin', '/t/pixelforge/admin/settings', '/t/pixelforge/admin/kb','/t/pixelforge/admin/tickets/00000000-0000-4000-8000-000000000000'] },
  { who: 'platform', paths: ['/platform'] },
];

setup('warm up dev routes', async ({ browser }) => {
  setup.setTimeout(600_000);
  for (const { who, paths } of WARM) {
    for (const p of paths) {
      const ctx = await browser.newContext(who ? { storageState: authFile(who) } : {});
      const page = await ctx.newPage();
      await page.goto(p, { timeout: 180_000 });
      // 클라이언트 렌더가 끝나 로딩 표시가 사라질 때까지
      await expect(page.locator('main, [data-testid^="view-"]').first()).toBeVisible({ timeout: 180_000 });
      await ctx.close();
    }
  }
});
