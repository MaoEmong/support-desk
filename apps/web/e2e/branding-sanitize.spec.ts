import { expect, test } from '@playwright/test';
import { contextAs, uniq } from './helpers';

interface PublicSettings {
  displayName: string;
  primaryColor: string | null;
  chatbotName: string;
}

test('테넌트별 브랜딩: 이름과 --brand 색이 설정값대로 서로 다름', async ({ browser }, testInfo) => {
  const ctx = await contextAs(browser, testInfo, null);
  const page = await ctx.newPage();
  const seen: Record<string, { name: string; brand: string }> = {};
  for (const slug of ['pixelforge', 'mailpulse']) {
    const settings = (await (await ctx.request.get(`/api/t/${slug}/settings/public`)).json()) as PublicSettings;
    await page.goto(`/t/${slug}`);
    const name = (await page.getByTestId('tenant-name').textContent())?.trim() ?? '';
    const brand = await page.locator(`[data-tenant="${slug}"]`).evaluate((el) => getComputedStyle(el).getPropertyValue('--brand').trim());
    expect(name).toBe(settings.displayName);
    if (settings.primaryColor) expect(brand.toLowerCase()).toBe(settings.primaryColor.toLowerCase());
    await expect(page.getByText(settings.chatbotName).first()).toBeVisible();
    seen[slug] = { name, brand };
  }
  expect(seen.pixelforge.name).not.toBe(seen.mailpulse.name);
  expect(seen.pixelforge.brand).not.toBe(seen.mailpulse.brand);
  await ctx.close();
});

test('마크다운 sanitize: script·img 미렌더링, 비허용 링크는 텍스트', async ({ browser }, testInfo) => {
  const ctx = await contextAs(browser, testInfo, 'customer1');
  const page = await ctx.newPage();
  const title = uniq('XSS 검사');
  await page.goto('/t/pixelforge/tickets/new');
  await page.getByLabel('제목').fill(title);
  await page
    .getByLabel('내용')
    .fill('<script>window.__xss=1</script>\n\n[악성](https://evil.attacker.test)\n\n<img src=x onerror="window.__xss=2">\n\n정상 문장입니다.');
  await page.getByRole('button', { name: '문의 등록' }).click();
  await expect(page.getByRole('heading', { name: title })).toBeVisible();

  const message = page.getByTestId('message').first();
  await expect(message).toContainText('정상 문장입니다.');
  await expect(page.locator('[data-testid="message"] script')).toHaveCount(0);
  await expect(page.locator('[data-testid="message"] img')).toHaveCount(0);
  await expect(page.locator('a[href*="evil.attacker.test"]')).toHaveCount(0);
  await expect(message.locator('[data-blocked-link="true"]', { hasText: '악성' })).toBeVisible();
  expect(await page.evaluate(() => (window as unknown as { __xss?: number }).__xss)).toBeUndefined();
  await ctx.close();
});
