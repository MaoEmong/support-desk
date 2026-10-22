import { expect, type APIRequestContext, type Browser, type BrowserContext, type BrowserContextOptions, type TestInfo } from '@playwright/test';
import { ACCOUNTS, BASE_URL, PASSWORD, authFile, type Who } from './env';

/** 프로젝트(데스크톱/모바일) 화면 설정을 유지한 채 추가 컨텍스트를 만든다. */
export function projectContextOptions(testInfo: TestInfo): BrowserContextOptions {
  const u = testInfo.project.use;
  return {
    baseURL: u.baseURL,
    viewport: u.viewport,
    isMobile: u.isMobile,
    hasTouch: u.hasTouch,
    deviceScaleFactor: u.deviceScaleFactor,
    userAgent: u.userAgent,
    locale: u.locale,
  };
}

/** setup 프로젝트가 저장한 세션으로 로그인된 컨텍스트(로그인 반복 → 시도 제한 회피) */
export function contextAs(browser: Browser, testInfo: TestInfo, who: Who | null): Promise<BrowserContext> {
  return browser.newContext({ ...projectContextOptions(testInfo), ...(who ? { storageState: authFile(who) } : {}) });
}

/** API 로그인 → 쿠키(sd_session·sd_csrf 등)를 담은 request 컨텍스트 반환 */
export async function apiLogin(request: APIRequestContext, who: Who) {
  const acc = ACCOUNTS[who];
  const path = acc.slug ? `/api/t/${acc.slug}/auth/login` : '/api/platform/auth/login';
  const res = await request.post(path, { data: { email: acc.email, password: PASSWORD }, headers: { origin: BASE_URL } });
  expect(res.status(), `${who} 로그인 실패: ${await res.text()}`).toBe(200);
}

/** 브라우저 컨텍스트의 쿠키(CSRF 포함)로 API 호출. 테스트 데이터 준비용. */
export async function apiAs<T>(context: BrowserContext, method: 'GET' | 'POST' | 'PATCH', path: string, body?: unknown, headers: Record<string, string> = {}): Promise<T> {
  const csrf = (await context.cookies(BASE_URL)).find((c) => c.name === 'sd_csrf')?.value;
  const res = await context.request.fetch(`/api${path}`, {
    method,
    data: body,
    headers: { origin: BASE_URL, ...(csrf && method !== 'GET' ? { 'x-csrf-token': csrf } : {}), ...headers },
  });
  expect(res.ok(), `${method} ${path} → ${res.status()} ${await res.text()}`).toBeTruthy();
  return (await res.json()) as T;
}

export const uniq = (prefix: string) => `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;

/** 고객 세션으로 티켓 생성(API) */
export function createTicket(context: BrowserContext, slug: string, title: string, body = `${title} 본문입니다.`) {
  return apiAs<{ id: string; title: string }>(context, 'POST', `/t/${slug}/tickets`, { title, body }, { 'idempotency-key': uniq('key') });
}
