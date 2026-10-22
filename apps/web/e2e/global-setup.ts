import { createRequire } from 'node:module';
import path from 'node:path';
import { E2E_DATABASE_URL, E2E_DIR } from './env';

interface PgClient {
  connect(): Promise<void>;
  query(sql: string): Promise<unknown>;
  end(): Promise<void>;
}

/**
 * DB 전체 초기화(drop/create → migrate → seed)는 여기서 하지 않는다. Playwright가 webServer를 globalSetup보다
 * 먼저 띄우기 때문에, playwright.config.ts의 webServer 명령 앞단(`pnpm -w db:seed --reset`)에서 서버 기동 전에 한다.
 * 여기서는 로그인 시도 제한(계정·IP 키)만 비운다. 초기화를 건너뛴 재실행(E2E_SKIP_DB_RESET=1, 서버 재사용)에서도 막히지 않게 하기 위해서다.
 * 안전장치: DB 이름이 _e2e로 끝나지 않으면 아무것도 하지 않고 실패한다(시연 DB 보호).
 */
export default async function globalSetup() {
  const dbName = new URL(E2E_DATABASE_URL).pathname.slice(1);
  if (!dbName.endsWith('_e2e')) throw new Error(`E2E DB가 아닙니다: ${dbName}`);
  // pg는 @support/db 의존성이라 그 패키지 기준으로 불러온다
  const req = createRequire(path.resolve(E2E_DIR, '../../../packages/db/package.json'));
  const { Client } = req('pg') as { Client: new (opts: { connectionString: string }) => PgClient };
  const client = new Client({ connectionString: E2E_DATABASE_URL });
  await client.connect();
  try {
    await client.query('DELETE FROM login_attempts');
  } finally {
    await client.end();
  }
}
