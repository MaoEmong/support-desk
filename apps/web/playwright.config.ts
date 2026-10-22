import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { defineConfig, devices } from '@playwright/test';
import { BASE_URL, E2E_DATABASE_URL, E2E_DIR, HOST, OUTPUT_DIR, PORT, REPORT_DIR, WEBSERVER_LOG } from './e2e/env';

/**
 * E2E: 실제 Next dev 서버 + AI 워커 + E2E 전용 Postgres DB(support_desk_e2e).
 * 로그인 시도 제한과 공유 DB 때문에 workers 1, 세션은 setup 프로젝트가 만든 storageState를 재사용한다.
 */

// 설정을 읽는 시점(webServer·globalSetup보다 먼저)에 E2E DB가 아니면 바로 중단한다
const e2eDbName = decodeURIComponent(new URL(E2E_DATABASE_URL).pathname.slice(1));
if (!e2eDbName.endsWith('_e2e')) throw new Error(`E2E_DATABASE_URL은 _e2e DB여야 합니다: ${e2eDbName}`);

/**
 * DB 초기화: Playwright는 webServer(plugin setup)를 globalSetup보다 먼저 띄운다.
 * 백엔드 `seed --reset`은 대상 DB에 연결이 있으면 거부하므로, 서버가 뜨기 전에 명령 앞단에서 실행한다.
 * --reset = _e2e 이름·localhost 검증 → drop/create → migrate → seed.
 * E2E_SKIP_DB_RESET=1이면 생략(이미 준비된 DB로 재실행할 때). reuseExistingServer면 명령 자체가 실행되지 않는다.
 */
const resetCommand = process.env.E2E_SKIP_DB_RESET === '1' ? null : 'pnpm -w db:seed --reset';
/**
 * 서버 명령(cwd = apps/web). 기본은 web+worker(백엔드 실측 명령): 루트 `dev`(scripts/dev.mjs)가 뒤 인자를 web(next dev)에 넘긴다.
 * 웹만 띄우려면 E2E_WEB_COMMAND="pnpm dev --port 3200 --hostname 127.0.0.1"(apps/web의 next dev).
 */
const serverCommand = process.env.E2E_WEB_COMMAND ?? `pnpm -w dev --port ${PORT} --hostname ${HOST}`;
const chained = resetCommand ? `${resetCommand} && ${serverCommand}` : serverCommand;
/**
 * webServer 출력은 Playwright 보고 경로로 들어오지 않으므로 셸 리다이렉트로 파일에 남긴다(재컴파일 횟수 집계용).
 * `( … ) > "파일" 2>&1`은 cmd.exe(Windows 기본 셸)와 sh 모두에서 동작한다. 로그를 남기면 콘솔에는 서버 오류가 보이지 않으니 파일을 본다.
 */
if (WEBSERVER_LOG) mkdirSync(path.dirname(WEBSERVER_LOG), { recursive: true });
const webServerCommand = WEBSERVER_LOG ? `(${chained}) > "${WEBSERVER_LOG}" 2>&1` : chained;

export default defineConfig({
  testDir: './e2e',
  outputDir: path.join(OUTPUT_DIR, 'test-results'),
  globalSetup: './e2e/global-setup.ts',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 90_000,
  expect: { timeout: 15_000 },
  // json: serial 그룹에서 첫 실패 뒤 테스트는 skipped로 기록돼 최초 실패와 연쇄를 구분할 수 있다
  reporter: [
    ['list'],
    ['json', { outputFile: path.join(REPORT_DIR, 'report.json') }],
    ['html', { outputFolder: path.join(REPORT_DIR, 'html'), open: 'never' }],
  ],
  use: {
    baseURL: BASE_URL,
    locale: 'ko-KR',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    actionTimeout: 15_000,
    navigationTimeout: 60_000,
  },
  projects: [
    { name: 'setup', testMatch: /auth\.setup\.ts/ },
    {
      name: 'desktop',
      use: { ...devices['Desktop Chrome'], viewport: { width: 1280, height: 800 } },
      dependencies: ['setup'],
      testIgnore: /auth\.setup\.ts/,
    },
    {
      name: 'mobile',
      use: { ...devices['Desktop Chrome'], viewport: { width: 375, height: 812 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 },
      dependencies: ['setup'],
      testIgnore: /auth\.setup\.ts/,
    },
  ],
  webServer: {
    command: webServerCommand,
    cwd: path.resolve(E2E_DIR, '..'),
    url: `${BASE_URL}/api/t/pixelforge/settings/public`,
    // 기본은 항상 새 서버. 로컬 디버깅 때만 E2E_REUSE_SERVER=1로 이미 띄운 같은 설정의 서버를 쓴다.
    reuseExistingServer: process.env.E2E_REUSE_SERVER === '1',
    // DB 초기화 + web·worker 기동 + 첫 컴파일까지 포함
    timeout: 300_000,
    stdout: 'ignore',
    stderr: 'pipe',
    // scripts/processes.mjs의 launchPnpm이 {...process.env}로 web·worker 양쪽에 그대로 넘긴다(루트 .env는 덮어쓰지 않음)
    env: {
      DATABASE_URL: E2E_DATABASE_URL,
      AI_MODE: 'mock',
      WORKER_POLL_INTERVAL_MS: '500',
      SESSION_SECRET: 'e2e-session-secret-0123456789abcdef-not-for-prod',
      APP_URL: BASE_URL,
      // 포트 인자가 전달되지 않는 명령을 쓸 때를 위한 보조값(next dev는 PORT도 읽는다)
      PORT: String(PORT),
      NEXT_TELEMETRY_DISABLED: '1',
    },
  },
});
