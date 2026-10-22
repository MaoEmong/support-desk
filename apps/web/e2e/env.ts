import { DEMO_ACCOUNTS } from '@support/contracts';
import { DEMO_PASSWORD } from '../src/lib/demo-accounts';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** apps/web/e2e (package.json type=module이라 __dirname 대신) */
export const E2E_DIR = path.dirname(fileURLToPath(import.meta.url));
/**
 * 결과물(세션 storageState·trace·리포트)은 앱 폴더 밖에 쓴다.
 * apps/web 안에 쓰면 next dev 파일 감시가 매번 재컴파일하고, 그 사이 매니페스트를 읽던 요청이 500(Unexpected end of JSON input)이 된다.
 */
export const OUTPUT_DIR = process.env.E2E_OUTPUT_DIR ?? path.join(os.tmpdir(), 'support-desk-e2e');
/**
 * 검증 근거로 남길 리포트(json·html) 위치. 저장소 루트의 docs/ 아래라 apps/web(next dev 감시 범위) 밖이다.
 * trace·storageState 같은 결과물은 OUTPUT_DIR(%TEMP%)에 그대로 둔다.
 */
export const REPORT_DIR = process.env.E2E_REPORT_DIR ?? path.resolve(E2E_DIR, '..', '..', '..', 'docs', 'verification', 'stage2', 'e2e');
/** webServer(DB 초기화 + web + worker)의 stdout·stderr 로그. 재컴파일('Compiled') 횟수를 센다. 빈 문자열이면 남기지 않는다. */
export const WEBSERVER_LOG = process.env.E2E_WEBSERVER_LOG ?? path.join(REPORT_DIR, 'webserver.log');

export const PORT = 3200;
/**
 * host는 127.0.0.1로 고정한다. dev 서버가 127.0.0.1에만 바인딩하고(Windows에서 localhost가 ::1로 풀리면 연결 실패),
 * 서버 tenant-guard가 변경 요청의 Origin을 APP_URL과 비교하므로 baseURL·webServer url·APP_URL이 모두 같아야 한다.
 */
export const HOST = '127.0.0.1';
export const BASE_URL = `http://${HOST}:${PORT}`;
/** 시연용 DB(support_desk)와 분리된 E2E 전용 DB */
export const E2E_DATABASE_URL = process.env.E2E_DATABASE_URL ?? 'postgresql://support:support@localhost:55432/support_desk_e2e';
/** 데모 계정 비밀번호: 프론트 상수(DEMO_PASSWORD = 시드 기본값) 하나를 쓴다. */
export const PASSWORD = DEMO_PASSWORD;

/** contracts DEMO_ACCOUNTS에서 이메일로 찾는다(표에 없으면 설정 로드 시점에 실패). */
function demo(email: string): { slug: string | null; email: string } {
  const account = DEMO_ACCOUNTS.find((a) => a.email === email);
  if (!account) throw new Error(`DEMO_ACCOUNTS에 없는 계정: ${email}`);
  return { slug: account.tenantSlug, email: account.email };
}

/** 테스트에서 쓰는 역할 이름 → DEMO_ACCOUNTS 계정 */
export const ACCOUNTS = {
  customer1: demo('c1@pf.test'),
  customer2: demo('c2@pf.test'),
  agent: demo('agent@pf.test'),
  admin: demo('admin@pf.test'),
  mpCustomer: demo('c1@mp.test'),
  platform: demo('admin@platform.test'),
};
export type Who = keyof typeof ACCOUNTS;

export const authFile = (who: Who) => path.join(OUTPUT_DIR, 'auth', `${who}.json`);
