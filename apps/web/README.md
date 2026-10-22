# apps/web — 프론트엔드 절 (초안)

> 이 문서는 루트 README에 절 단위로 옮겨 붙일 수 있게 썼다. 각 `##` 절은 서로 독립적이다.
> 실행 결과 수치는 최종 D 단계 실행 뒤 채운다.

## 검증 결과 (D 단계 동결 최종 실행, 2026-10-22)

리포트는 저장소의 `docs/verification/stage2/e2e/`에 있다.
- `report.json`, `html/`: Playwright 결과
- `gates.txt`: 게이트별 명령·exit·시간
- `webserver.log`: DB 초기화·web·worker 출력
- `measurements.md`: 실측 3가지
- `snapshot-*.txt`, `check-*.txt`: 동결 스냅샷과 점검
- `run1/`: 1차 실행 자료

| 게이트 (apps/web 기준) | exit | 시간 |
| --- | --- | --- |
| `npx tsc --noEmit --incremental false` | 0 | 8.0s |
| `npx eslint src e2e` | 0 | 3.7s |
| `pnpm --filter @support/web build` | 0 | 29.6s |
| `npx playwright test` (DB reset + web+worker, retries 0, workers 1) | 0 | 377.1s |

**Playwright:** 61건 통과, 실패 0, skip 0, flaky 0. 리포트 기준 소요 시간은 375.4s다.

| 프로젝트 | 통과 / 전체 |
| --- | --- |
| setup(로그인 + 라우트 워밍업 44.2s) | 7 / 7 |
| desktop (1280×800) | 27 / 27 |
| mobile (375×812) | 27 / 27 |

| spec | desktop | mobile | 내용 |
| --- | --- | --- | --- |
| `customer-flow` | 1/1 | 1/1 | 가입 → 문의 → 상담원 답변 폴링 반영 → 해결 확인 |
| `isolation` | 2/2 | 2/2 | 다른 고객 404, 교차 테넌트 차단 |
| `roles` | 6/6 | 6/6 | 역할별 메뉴·403, 로그인 폼, 플랫폼 집계 전용, Mock 배지 |
| `branding-sanitize` | 2/2 | 2/2 | 테넌트 브랜딩, 마크다운 sanitize |
| `chat` | 1/1 | 1/1 | 챗봇 이관 → 문의글 전환 |
| `conflict` | 1/1 | 1/1 | 상태 변경 409 |
| `review-fixes` | 3/3 | 3/3 | KB 다이얼로그 포커스 복귀, 정상 로그아웃, 초안 없는 상세 |
| `a11y` | 1/1 | 1/1 | axe serious/critical 0, 375px scrollWidth ≤ 375 |
| `stage2-integration` | 10/10 | 10/10 | 시나리오 1~6(FAQ 자동답변·해결, 환불 이관·초안 승인·409, 챗봇 FAQ 스트리밍·해킹 이관 전환, 승인 모드 티켓·챗봇 자동 접수, 임계값 0.85, 상담원 추가·비활성화), mailpulse FAQ, KPI |

- **접근성:** axe(wcag2a/aa, 21a/aa) 기준 serious·critical 위반 0건이다. 대상은 로그인, 고객 목록·상세, 챗봇 패널, 대시보드 큐·상세, KB, 설정이고 데스크톱·모바일에서 모두 검사했다. 375px에서 모든 대상 화면이 `scrollWidth ≤ 375`였다. Lighthouse는 실행하지 않았다.
- **실행 환경 실측(`measurements.md`):**
  - `--reset`, `--port 3200`, `--hostname 127.0.0.1` 인자가 하위 스크립트까지 전달됐다.
  - 종료 직후 3200 리스너, node(dev.mjs·next·worker) 프로세스, `_e2e` DB 연결이 모두 0이었다.
  - 파일 변경으로 인한 재컴파일은 0회였다.

## 화면 구성

한 Next.js 앱(App Router) 안에 영역이 세 개 있다. 테넌트는 경로 `/t/{slug}`로 구분한다.

| 영역 | 경로 | 대상 | 주요 화면 |
| --- | --- | --- | --- |
| 고객 포털 | `/t/{slug}` | 비로그인·고객 | 첫 화면, 로그인·회원가입, 내 문의 목록 `/tickets`, 문의 작성 `/tickets/new`, 문의 상세 `/tickets/{id}`, 챗봇 위젯(로그인한 고객에게만, 우하단) |
| 대시보드 | `/t/{slug}/admin` | 상담원·테넌트 관리자 | 티켓 큐, 티켓 상세(대화 이력·공개 답변/내부 메모·배정·상태·AI 초안·AI 분석), KPI, KB / FAQ |
| 플랫폼 | `/platform` | 플랫폼 관리자 | 테넌트 목록·상태·집계 수치만. 티켓·메시지 본문 화면은 없다 |

- **역할별 메뉴.** 대시보드 메뉴는 `티켓 큐 · KPI · KB / FAQ`가 공통이다. `상담원`, `설정`은 테넌트 관리자에게만 보인다. 메뉴를 숨기는 것과 별도로 라우트도 막는다. 역할이 맞지 않으면 403 화면을 보여준다. 실제 격리와 권한은 서버가 강제하고, 화면 가드는 UX용이다.
- **오류 화면.** 401(로그인 화면으로 이동, `next` 유지), 403, 404(다른 고객·다른 테넌트 리소스 포함), 409(동시 수정 충돌, 최신 내용 불러오기)를 공통 컴포넌트(`src/components/states.tsx`)로 처리한다.
- **테넌트 브랜딩.** 화면 문구와 색은 테넌트 공개 설정값(`displayName`, `chatbotName`, `logoUrl`, `primaryColor`)으로만 바뀐다.
  - 브랜드 색은 CSS 변수 `--brand`로 주입한다.
  - 글자색 `--brand-foreground`는 흰색과 검정 중 대비가 큰 쪽을 계산해 고른다. 이렇게 하면 항상 4.5:1 이상이 된다.
  - 코드에 업종이나 회사명을 하드코딩하지 않는다. 같은 코드가 게임사와 마케팅 SaaS 테넌트를 다르게 보여준다.
- **모바일 우선.** 고객 포털은 375px 폭을 기준으로 만들었다. 버튼 최소 높이는 40px이다.

## 시연 화면 단계

### 데모 계정

계정 목록은 `@support/contracts`의 `DEMO_ACCOUNTS`가 기준이다(9개). 비밀번호는 모두 `demo1234`이고, 시드 기본값이다. 시드에서 `SEED_PASSWORD`를 주면 그 값이 쓰인다.

| 테넌트 | 로그인 주소 | 역할 | 이메일 |
| --- | --- | --- | --- |
| pixelforge | `/t/pixelforge/login` | 고객 1 / 고객 2 | `c1@pf.test` / `c2@pf.test` |
| pixelforge | `/t/pixelforge/login` | 상담원 / 관리자 | `agent@pf.test` / `admin@pf.test` |
| mailpulse | `/t/mailpulse/login` | 고객 1 / 고객 2 | `c1@mp.test` / `c2@mp.test` |
| mailpulse | `/t/mailpulse/login` | 상담원 / 관리자 | `agent@mp.test` / `admin@mp.test` |
| 플랫폼 | `/platform/login` | 플랫폼 관리자 | `admin@platform.test` |

- **데모 로그인 버튼(선택, 기본 꺼짐).** `NEXT_PUBLIC_DEMO_ACCOUNTS=1`이면 테넌트 로그인 화면에는 그 테넌트 계정, 플랫폼 로그인 화면에는 플랫폼 계정 버튼이 나온다. 버튼을 누르면 일반 로그인과 같은 API로 바로 로그인한다.
  - 판정 함수는 `src/lib/demo-accounts.ts`의 `isDemoLoginEnabled`다. 정확히 `'1'`일 때만 켜진다.
  - 이 버튼은 코드만 작성했고 실행 검증은 하지 않았다.
- **`NEXT_PUBLIC_` 값은 공개값이다.** 클라이언트 번들에 들어가고, 운영 build 시점에 고정된다(build 뒤에 env를 바꿔도 반영되지 않는다).
- **`SEED_PASSWORD`로 다른 비밀번호를 쓰는 환경에서는 버튼을 끈다.** 버튼은 `demo1234`로 제출한다.
- **운영에서는 데모 계정 자체를 비활성화하거나 교체한다.** 버튼만 끄는 것으로는 공개된 비밀번호 계정이 남는다.

시연 문장은 `@support/ai/data`의 demo 세트(`packages/ai/data/demo/{slug}.json`)에 있는 **키 이름**으로만 가리킨다. 문장 본문은 그 파일에서 복사해 쓴다.

| 키 | 테넌트 | 채널 | 기대 결과 |
| --- | --- | --- | --- |
| `faq_install` | pixelforge | 문의글 | 자동답변(근거 포함) |
| `refund_escalate` | pixelforge, mailpulse | 문의글 | 상담원 이관 + 초안 |
| `hacking_escalate`, `sanction_escalate` | pixelforge | 문의글 | 상담원 이관 |
| `approval_pending` | pixelforge | 문의글 | 승인 대기(승인 모드를 켠 뒤) |
| `chat_faq` | pixelforge, mailpulse | 챗봇 | 스트리밍 자동답변 |
| `chat_hacking` / `chat_account_security` | pixelforge / mailpulse | 챗봇 | 이관 안내(토큰 없음) |
| `threshold_boundary` | pixelforge, mailpulse | 문의글 | 기본 임계값에서는 자동답변, 임계값을 올리면 이관 |
| `faq_campaign`, `account_security_escalate` | mailpulse | 문의글 | 자동답변 / 이관 |

### 1. FAQ 자동답변과 해결 확인 (`faq_install`)
1. pixelforge 고객 1로 `/t/pixelforge/login`에서 로그인하면 「내 문의」로 이동한다.
2. 「문의하기」에서 제목과 내용(`faq_install` 문장)을 입력하고 「문의 등록」을 누르면 상세 화면으로 이동한다. 상태 배지는 「접수됨」이다.
3. 상세 화면은 4초마다 갱신된다.
   - 「AI 답변」 배지가 붙은 답변과 「참고한 문서」 목록이 나타나고, 상태는 「답변 도착」으로 바뀐다.
4. 「해결되었어요」를 누르고, 확인 다이얼로그에서 「해결 확인」을 누르면 상태가 「해결됨」이 된다.

### 2. 환불 이관과 초안 승인 (`refund_escalate`)
1. 고객이 `refund_escalate` 문장으로 문의를 등록한다. 상세 화면에는 「문의를 확인하고 있습니다」 안내가 나온다.
2. 상담원으로 `/t/pixelforge/admin`에 들어가 「티켓 큐」에서 해당 티켓을 확인한다. 이관 배지와 이관 사유가 보인다.
3. 티켓 상세의 「AI 초안」에서 내용을 편집하고 「초안 저장」을 누른 뒤 「승인·발송」을 누른다.
   - 다른 상담원이 먼저 처리했다면 409 안내가 뜨고, 편집 중인 내용은 보존된다.
4. 고객 상세 화면에 상담원 답변이 나타난다.

### 3. 챗봇 스트리밍과 해킹 이관 후 문의글 전환 (`chat_faq`, `chat_hacking`)
1. 고객 화면 우하단의 챗봇 버튼(테넌트 `chatbotName`)으로 패널을 연다.
2. `chat_faq` 문장을 보내면 답변이 스트리밍으로 나타나고, 끝에 근거 문서(발췌 포함)가 붙는다. 스트리밍 중에는 중단 버튼으로 멈출 수 있다.
3. 같은 대화에서 이어서 `chat_hacking` 문장을 보내면 답변 토큰 없이 「상담원 확인이 필요합니다」 안내가 나온다. 이관 사유가 공개되면 「사유」 한 줄도 함께 보인다.
4. 「문의글로 남기기」를 누른다. 제목 기본값은 첫 질문 앞부분이다. 「문의 등록」을 누르면 문의 상세로 이동한다. 첫 메시지에 대화 내용이 첨부되어 있다.
5. 위젯을 다시 열면 「이 대화는 문의글로 전환되었습니다」라고 표시되고 새 대화를 시작할 수 있다.

### 4. 승인 모드 (`approval_pending`)
1. 테넌트 관리자로 「설정」에서 「모든 AI 답변을 상담원 승인 후 발송」을 켜고 저장한다. 시드 기본값은 꺼져 있다.
2. 고객이 `approval_pending` 문장으로 문의를 등록한다. 고객 화면에는 「상담원이 확인한 후 답변드립니다」 안내만 나오고, 초안은 보이지 않는다.
3. 상담원이 「AI 초안」을 승인하면 그때 고객 화면에 답변이 나타난다.
4. 챗봇에서도 승인 모드면 「상담원 확인 후 답변드립니다」 안내가 나온다.
   - 서버가 문의를 자동으로 접수하면(응답 끝의 `done`에 ticketId) 위젯에 「문의가 접수되었습니다」와 「접수된 문의 보기」 링크가 나온다.
   - 이때 「문의글로 남기기」 버튼은 숨긴다. 새로고침해도 같은 상태로 복원된다.
   - 승인 모드가 아닌 이관(예: `chat_hacking`)은 자동으로 접수하지 않는다. 시나리오 3처럼 버튼으로 전환한다.
5. 시연이 끝나면 설정을 원래대로 끈다.

### 5. 임계값 변경 (`threshold_boundary`)
1. 기본 임계값(0.7)에서 `threshold_boundary` 문장으로 문의하면 자동답변된다.
2. 테넌트 관리자가 「설정」의 「자동답변 신뢰도 임계값 (0~1)」을 0.85로 올려 저장한다.
3. 같은 문장으로 새 문의를 등록하면 이번에는 이관된다. 상담원 상세의 「최신 AI 분석」에서 신뢰도와 사유를 확인할 수 있다.
4. 시연이 끝나면 임계값을 되돌린다.

### 6. 상담원 추가와 비활성화
1. 테넌트 관리자로 「상담원」 메뉴에서 「상담원 추가」를 누르고 이름과 이메일을 입력한 뒤 「상담원 생성」을 누른다.
2. 임시 비밀번호는 이 화면에서 한 번만 보인다. 「비밀번호 복사」로 복사한 뒤 「확인 후 닫기」를 누른다.
3. 중복 이메일이면 「이미 사용 중인 이메일입니다.」가 표시된다.
4. 「비활성화」를 누르면 「상담원을 비활성화하시겠습니까?」 확인 다이얼로그가 뜬다. 「비활성화 확정」을 누르면 해당 상담원의 기존 세션도 거부된다.
5. 상담원(agent) 계정에는 「상담원」 메뉴가 보이지 않고, 경로로 직접 접근하면 403이 나온다.

### KPI 화면
「KPI」 메뉴(`/t/{slug}/admin/metrics`)에서 다음을 확인한다.
- 자동해결률: 고객이 해결을 확인한 것을 기준으로 계산한다.
- 상담원 이관률
- 카테고리 분포
- 상태별 문의 수

AI_MODE가 mock이면 대시보드 상단에 「Demo(Mock) 모드」 배지가 표시된다.

### 플랫폼
플랫폼 관리자로 `/platform/login`에서 로그인하면 테넌트 카드 2개(상태·문의 수·이관·자동해결률 등 집계)만 보인다.

## E2E 실행법 (Playwright)

설정 파일은 `playwright.config.ts`, 공통 상수는 `e2e/env.ts`에 있다.

### 1. 전용 DB 준비
E2E는 시연 DB(`support_desk`)와 분리된 **이름이 `_e2e`로 끝나는 DB**만 쓴다.
- 기본값: `postgresql://support:support@localhost:55432/support_desk_e2e`
- 다른 DB를 쓰려면 `E2E_DATABASE_URL`로 바꾼다.
- **실행마다 자동 초기화.** `npx playwright test`가 서버를 띄우기 직전에 `pnpm -w db:seed --reset`을 먼저 실행한다.
  - `--reset`은 백엔드 시드 스크립트의 E2E 전용 경로다. 순서: localhost이면서 이름이 `_e2e`인지 검증 → drop/create → migrate → seed.
  - 대상 DB에 연결이 남아 있으면 초기화를 거부한다. 그래서 같은 DB를 쓰는 dev 서버·worker·psql 세션을 먼저 끈다.
  - Playwright는 webServer를 globalSetup보다 먼저 띄운다. 그래서 초기화는 globalSetup이 아니라 webServer 명령 앞단에 둔다.
- 초기화를 건너뛰려면 `E2E_SKIP_DB_RESET=1`을 준다(이미 준비된 DB로 재실행할 때).
- 안전장치는 세 겹이다.
  - `playwright.config.ts`가 설정을 읽는 시점에 DB 이름이 `_e2e`로 끝나지 않으면 바로 중단한다.
  - `e2e/global-setup.ts`도 같은 검사를 한 번 더 하고, `login_attempts`(로그인 시도 제한)를 비운다.
  - 백엔드 `--reset`이 다시 검증한다.

수동으로 초기화하려면 저장소 루트에서 다음을 실행한다.

```sh
DATABASE_URL=postgresql://support:support@localhost:55432/support_desk_e2e pnpm db:seed --reset
```

### 2. 브라우저 설치(최초 1회)
```sh
cd apps/web
npx playwright install chromium
```

### 3. 실행
```sh
cd apps/web
npx playwright test
```

- **주소는 `http://127.0.0.1:3200` 하나로 통일한다.** baseURL, webServer 준비 확인 url, 서버 env `APP_URL`이 모두 같다(`e2e/env.ts`의 `HOST`·`BASE_URL`).
  - dev 서버는 `--hostname 127.0.0.1`로 IPv4에만 바인딩한다. Windows에서 `localhost`가 `::1`로 풀리면 연결되지 않는다.
  - 서버 tenant-guard는 변경 요청의 Origin을 `APP_URL`과 비교한다. host가 다르면(localhost와 127.0.0.1) 403이 난다.
  - 브라우저로 직접 확인할 때도 `http://127.0.0.1:3200`으로 연다.
- **webServer(web+worker).** Playwright가 DB 초기화 후 서버를 직접 띄우고, 끝나면 종료한다(`reuseExistingServer`는 기본 false, 기동 제한 300초).
  - 실제로 실행되는 명령(cwd `apps/web`):
    ```sh
    (pnpm -w db:seed --reset && pnpm -w dev --port 3200 --hostname 127.0.0.1) > "<저장소>/docs/verification/stage2/e2e/webserver.log" 2>&1
    ```
  - `pnpm -w dev`는 루트 `dev`(`scripts/dev.mjs`)를 탄다. `dev.mjs`가 뒤 인자를 web(`next dev --port 3200 --hostname 127.0.0.1`)에 넘기고, AI worker(`pnpm worker`)를 함께 띄운다.
  - 서버에 주는 env는 다음과 같다. 두 프로세스가 같은 값을 상속한다(`scripts/processes.mjs`가 `process.env`를 그대로 넘기고, 루트 `.env`는 이미 있는 값을 덮어쓰지 않는다).
    - `DATABASE_URL`(= E2E DB), `AI_MODE=mock`, `WORKER_POLL_INTERVAL_MS=500`
    - `SESSION_SECRET`(테스트용 값), `APP_URL=http://127.0.0.1:3200`
    - `PORT=3200`(보조값), `NEXT_TELEMETRY_DISABLED=1`
  - **webserver.log:** DB 초기화, web, worker의 출력이 모두 이 파일에 남는다. 재컴파일 횟수는 이 파일의 `Compiled` 줄로 센다.
    - webServer 출력은 Playwright 리포트로 들어오지 않아서, 셸 리다이렉트로 저장한다.
    - 그 대신 서버 오류는 콘솔에 보이지 않으므로 이 파일을 확인한다.
    - 위치는 `E2E_WEBSERVER_LOG`로 바꾸고, 빈 값을 주면 남기지 않는다.
- **명령 전환용 env.**
  - `E2E_WEB_COMMAND`: 서버 명령을 바꾼다. 예를 들어 web만 띄우려면 `E2E_WEB_COMMAND="pnpm dev --port 3200 --hostname 127.0.0.1"`(apps/web의 next dev)을 준다.
    - 이 경우 AI 처리를 기다리는 `e2e/stage2-integration.spec.ts`는 통과하지 않는다. 앞단 DB 초기화와 로그 저장은 그대로 실행된다.
  - `E2E_SKIP_DB_RESET=1`: 앞단 DB 초기화를 생략한다.
  - `E2E_REUSE_SERVER=1`: 로컬 디버깅 때만, 이미 떠 있는 같은 설정의 서버를 재사용한다. 이때는 서버 명령도 초기화도 실행되지 않는다.
- **프로젝트.**
  - `setup`: 데모 계정별 API 로그인 → storageState 저장. 이어서 모든 라우트를 한 번씩 열어 dev 첫 컴파일을 미리 끝낸다.
  - `desktop`(1280×800), `mobile`(375×812): 모든 시나리오를 두 화면 크기에서 각각 실행한다.
- **workers 1, retries 0인 이유.**
  - 공유 DB와 계정 단위 로그인 시도 제한 때문에, 테스트를 병렬로 돌리면 서로 간섭한다.
  - 같은 이유로 세션은 storageState로 재사용하고, 테스트마다 로그인하지 않는다.
  - 불안정한 테스트를 재시도로 가리지 않도록 retries는 0이다.
- **리포트(검증 근거).** 기본 위치는 저장소의 `docs/verification/stage2/e2e/`이고, `E2E_REPORT_DIR`로 바꿀 수 있다. 콘솔에는 `list` 출력이 함께 나온다.
  - `report.json`: JSON 리포트. serial 그룹에서 첫 실패 뒤의 테스트는 `skipped`로 기록돼, 최초 실패와 연쇄 skip을 구분할 수 있다.
  - `html/`: HTML 리포트(자동으로 열지 않음). `npx playwright show-report ../../docs/verification/stage2/e2e/html`로 연다.
  - 저장소 루트의 `docs/`는 `apps/web` 밖이라 next dev 감시 대상이 아니다.
- **결과물 위치.** 기본 `%TEMP%\support-desk-e2e`(OS 임시 폴더)이고, `E2E_OUTPUT_DIR`로 바꿀 수 있다.
  - `auth/`: 세션 storageState
  - `test-results/`: 실패 스크린샷·trace
  - 앱 폴더 밖에 두는 이유: `apps/web` 안에 쓰면 next dev 파일 감시가 매번 재컴파일하고, 그 사이 매니페스트를 읽던 요청이 500을 받는다.

### 시나리오 파일
| 파일 | 내용 |
| --- | --- |
| `customer-flow.spec.ts` | 가입 → 문의 → 상담원 답변이 폴링으로 반영 → 해결 확인 |
| `isolation.spec.ts` | 다른 고객 티켓 404, 교차 테넌트 차단·로그인 실패 |
| `roles.spec.ts` | 역할별 메뉴·라우트(403), 로그인 폼 첫 화면, 미로그인 리다이렉트, 플랫폼 집계 전용, Mock 배지 |
| `branding-sanitize.spec.ts` | 테넌트별 이름·`--brand`, 마크다운 sanitize |
| `chat.spec.ts` | 챗봇 이관 안내 → 문의글 전환 |
| `conflict.spec.ts` | 상태 변경 동시 수정 409 |
| `review-fixes.spec.ts` | KB 다이얼로그 포커스 복귀·결과 안내, 정상 로그아웃, 초안 없는 상세 |
| `a11y.spec.ts` | axe 검사 + 375px 가로 넘침 |
| `stage2-integration.spec.ts` | 2단계 실제 워커·AI(mock) 통합 시나리오(web+worker 필요) |

## 접근성 검증 방식

- **axe-core.** `@axe-core/playwright`로 태그 `wcag2a`, `wcag2aa`, `wcag21a`, `wcag21aa`를 검사한다. **serious·critical 위반 0건**이어야 통과한다(`e2e/a11y.spec.ts`).
  - 대상 화면: 로그인, 고객 목록·상세, 챗봇 패널, 대시보드 큐·상세, KB 관리, 설정
  - 데스크톱과 모바일에서 모두 검사한다.
- **모바일 가로 넘침.** 375px 프로젝트에서 같은 화면마다 `document.documentElement.scrollWidth <= 375`를 확인한다.
- **키보드·포커스.** 다음을 E2E로 확인한다.
  - 챗봇이 열리면 입력창으로 포커스가 가고, Esc로 닫으면 여는 버튼으로 돌아온다.
  - KB 만들기 다이얼로그를 Esc로 닫거나 저장한 뒤 트리거 버튼으로 포커스가 돌아온다.
  - 결과 안내가 role=status로 전달된다.
- **화면 구현 원칙.**
  - 모든 입력에 라벨을 연결한다(`Field` + `fieldAria`).
  - 상태 변화는 `role=status` / `aria-live`로 알린다. 정적 안내 박스는 live region이 아니고, 동작 결과에만 `live`를 붙인다.
  - 사용자 본문의 마크다운 제목은 h3 이하로 낮춰 페이지 제목 구조를 지킨다.
- **Lighthouse는 실행하지 않았다.** 위 항목은 axe와 E2E로 검증한 범위만 뜻한다.

## 렌더링 보안

- **SafeMarkdown**(`src/components/safe-markdown.tsx`). 고객 글, 상담원 답변, AI 답변을 모두 이 컴포넌트로 렌더링한다.
  - 원시 HTML은 렌더링하지 않고(`skipHtml`), `rehype-sanitize`로 한 번 더 거른다.
  - 이미지는 렌더링하지 않고 대체 텍스트만 보여준다. 추적 픽셀과 외부 리소스를 막기 위해서다.
  - 링크는 같은 사이트 상대 경로이거나, http(s)이면서 허용 도메인(테넌트 공개 설정 `allowedLinkDomains`, 하위 도메인 포함)일 때만 `<a>`로 만든다. 나머지는 텍스트로 남긴다(`data-blocked-link`). `javascript:` 등 위험 스킴은 제거한다.
  - 답변 근거(「참고한 문서」)의 URL도 같은 규칙을 따른다. 허용되지 않은 URL은 링크 없이 텍스트로 보여준다.
  - **1차 방어는 서버 쪽 sanitize다.** AI 출력은 허용 마크다운과 허용 도메인 링크만 남긴다. 화면은 2차 방어다.
- **CSRF.** API 클라이언트(`src/lib/api.ts`)가 GET 외 요청에 CSRF 쿠키 값을 `X-CSRF-Token` 헤더로 자동으로 붙인다. 테넌트 영역과 플랫폼 영역은 쿠키를 따로 쓴다. 세션 쿠키는 HttpOnly다.
- **로그인 리다이렉트.** 로그인 후 `next`는 같은 테넌트 경로(`/t/{slug}/…`)만 허용한다(오픈 리다이렉트 방지). 또 역할에 맞지 않는 경로로는 보내지 않는다. 예를 들어 고객은 `/admin`으로 보내지 않는다.
- **로그아웃.** 성공했거나 세션이 이미 만료된 경우(401)에만 캐시를 비우고 이동한다. 그 밖의 실패는 세션이 살아 있을 수 있으므로 이동하지 않고 오류를 표시한다.

## 알려진 제한 (프론트)

- **열린 대화 목록 API가 없다.** 챗봇 대화 ID는 sessionStorage에 두고, 새로고침하면 `GET /t/{slug}/conversations/{id}`로 복원한다. 탭을 닫으면 이전 대화를 이어갈 수 없다.
- **고객 문의 상세에 「챗봇에서 전환된 문의」 표시가 없다.** 고객 티켓 DTO에 `conversationId`가 없어서다. 전환 내역은 첫 메시지 본문에만 있다.
- **비밀번호 변경 화면이 없다.** 상담원 임시 비밀번호도 변경 화면이 없다.
- **전환기 SSE 호환 코드.** 챗봇 위젯은 계약 SSE 스키마로 먼저 파싱하고, 계약에 아직 맞지 않는 응답(1단계 스텁의 사유 값, excerpt가 없는 근거 등)은 필요한 필드만 느슨하게 읽는다(`src/components/customer/chat-widget.tsx`).
  - 이 코드는 `TODO(stage2-cutover)`로 표시해 두었다. 백엔드 반영이 끝나면 지운다.
  - 대화 복원 안내 코드(`NoticeCode`)는 contracts에 enum이 생길 때까지 `src/lib/types.ts`의 로컬 union으로 둔다.
