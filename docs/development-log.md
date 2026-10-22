# 개발 기록 (이전 루트 README)

> 포트폴리오 공개 전 루트 README.md를 그대로 옮겨 보존한 문서다. 단계별 검증 이력과 당시 결정 사항이 들어 있다. 현재 소개는 [README.md](../README.md)를 본다.

# Support Desk

## 최종 검증 (창4)

전체 typecheck/lint/build exit0, 실제 PostgreSQL 포함 Vitest **23파일271pass0fail0skip**. 프론트 동결 Playwright **61 expected/0unexpected/0skip/0flaky**, axe serious/critical0, Lighthouse 미실행입니다. AI 최종2회차는 tsc/엄격tsc/eslint/webtsc0, Vitest137/137, 안전위반0, demo14/14, 같은16행 judge16/16, 공유쓰기0·자식0·지정5버전일치입니다. [최종 근거](backend-verification.md), [AI 원문](verification/stage2/ai-eval.txt), [프론트 결과](verification/stage2/e2e/report.json). 아래 초기 검증·TASK573 기록은 당시 이력입니다.

## 아키텍처

```mermaid
flowchart LR
 Browser[고객·상담원·관리자] --> Web[Next.js UI / API]
 Web --> PG[(PostgreSQL / pgvector)]
 Web --> SSE[SSE 정책 선판단]
 Worker[독립 DB queue worker] --> PG
 Worker --> AI[AI mock / Claude adapter]
 SSE --> AI
 AI --> KB[테넌트 KB / revision cache]
```

## 시나리오 1~6

1. FAQ 문의 → 새 worker job → 자동답변·공개 근거 → 고객 해결 확인.
2. 환불·해킹·제재 → 자동답변 금지 → 상담원 이관·초안 검토.
3. 승인 모드 → 고객에게 초안 비노출 → 승인 후 공개; 동시 승인은 한쪽409/메시지1건.
4. 챗봇 SSE·복원. 자동 승인 전환은 done.data.ticketId, 고객 클릭은 convert 응답 ticketId입니다.
5. 상담원 생성·단회 임시 비밀번호·비활성 세션 거부·타테넌트404.
6. 임계값0.85 경계 문의와 FAQ 비교·KPI 확인. override는 처리 후 복원합니다.

## KPI·보안·제한과 로드맵

자동해결률 분모는 기간 생성 티켓, 분자는 AI 답변 이후 고객이 해결 확인한 티켓입니다. 이관률과 카테고리 분포도 티켓당1회, 기간은 UTC [from,to)입니다.

bcryptjs/HttpOnly 세션/CSRF/로그인 제한, tenant 복합FK/API 권한검사, 고객 whitelist·Markdown sanitize·허용 링크 도메인을 적용합니다. sessions.id는 SHA256 토큰 해시 text입니다. RLS는 미사용이며 신뢰 프록시는 외부 x-forwarded-for를 덮어써야 합니다. 설정 PATCH는 last-write-wins/audit이며 version·autoAnswerLimit 입력을 strict 거부합니다.

Claude 실호출 미검증, Windows OS SIGTERM 전달 미검증/소유 tree 정리 확인, static-paths 운영build미재현/원인미확정입니다. 고객 목록 N+1 최대50, 비밀번호 변경 UI·운영 비밀관리/관측·백업·부하검증은 후속 로드맵입니다. 열린 대화 목록 API는 없습니다. 대화 ID는 sessionStorage에 저장하므로 탭을 닫으면 이전 대화를 목록에서 찾아 이어갈 수 없습니다. [프론트 상세·접근성·제한](../apps/web/README.md)과 [실측·정리](verification/stage2/e2e/measurements.md)를 참고하세요.


게임사 PixelForge와 마케팅 SaaS MailPulse를 위한 멀티테넌트 고객지원 포트폴리오입니다. 회원 전용 비공개 문의, 고객 챗봇, 상담원 답변·내부 메모, AI 초안 승인, 테넌트별 정책을 구현합니다. 플랫폼 관리자는 테넌트 현황·집계만 조회합니다.

## 구성

- `apps/web`: Next.js 고객 포털·대시보드·API
- `packages/db` (`@support/db`): Drizzle/PostgreSQL 스키마·SQL 마이그레이션·시드
- `packages/contracts` (`@support/contracts`): Zod 요청·응답, 고객/staff 분리, 상태·오류·SSE 계약
- `packages/queue` (`@support/queue`): DB 작업 큐, lease·재시도·중복 발송 방지
- `packages/ai` (`@support/ai`): AI 공급자·정책·테넌트 KB (다른 팀 소유)

## 로컬 실행

Node.js 22+, pnpm 11.25.0, Docker Compose가 필요합니다. packageManager도 실제 검증에 사용한 pnpm 11.25.0으로 고정했습니다. 저장소 루트 PowerShell에서 실행합니다.

```powershell
Copy-Item .env.example .env
corepack enable
pnpm install
docker compose up -d --wait
pnpm db:migrate
pnpm db:seed
pnpm dev
```

검증과 같은 origin으로 실행하려면 루트 PowerShell에서 다음을 사용합니다. 브라우저도 반드시 `http://127.0.0.1:3200`으로 접속합니다.

```powershell
$env:APP_URL='http://127.0.0.1:3200'
$env:APP_ORIGINS='http://127.0.0.1:3200'
pnpm dev --port 3200 --hostname 127.0.0.1
```

web·worker는 같은 실행 환경을 상속합니다. APP_URL·허용 origin·브라우저 URL의 호스트와 포트를 맞추며 CSRF 검사는 유지합니다.
웹은 `http://localhost:3000`입니다. DB는 `localhost:5432/support_desk`, 개발 사용자/비밀번호는 `support/support`입니다. pgvector 확장은 첫 마이그레이션에서 활성화합니다. 초기 검색은 키워드/전문검색이며 벡터 검색은 아직 사용하지 않습니다.

`pnpm dev`는 web과 독립 worker를 함께 실행하며, `pnpm worker`는 worker만 실행합니다. worker bootstrap은 `apps/web/src/server/ai/worker-bootstrap.ts`의 `createWorkerDependencies`입니다. 이전 프론트 기준선을 확인하거나 worker 연동을 따로 점검할 때는 `pnpm dev:web`으로 web만 실행할 수 있습니다. 이 경우 큐 작업 처리는 별도 worker가 필요합니다. 통합 검증 중에는 서버·E2E 실행 담당자와 조정한 뒤 기동합니다.

5432가 사용 중이면 `POSTGRES_PORT=55432`로 Compose 포트를 바꾸고 DATABASE_URL의 포트도 55432로 맞추세요. 이번 검증은 기존 서비스를 유지하기 위해 55432를 사용했습니다.

루트 `pnpm dev`/`pnpm worker` wrapper와 DB 패키지는 루트 `.env`를 읽습니다. 기본 절차에 추가 `.env.local` 복사는 필요하지 않습니다. 프로세스에 이미 지정한 환경변수가 우선합니다. `AI_MODE=mock`은 결정적 데모 모드입니다. `claude` 모드는 `ANTHROPIC_API_KEY`가 필요하며 키가 없으면 설정 오류로 처리합니다.

## 데모 계정

계정 표는 `@support/contracts`의 `DEMO_ACCOUNTS`(서브패스 `@support/contracts/demo-accounts`) 하나이며 seed·전환 스크립트·로그인 화면이 같이 씁니다. 표에는 비밀번호가 없습니다.
비밀번호는 seed 환경에서 정합니다: `SEED_PASSWORD`가 있으면 그 값, 없거나 비어 있으면 `demo1234`. 새로 만드는 계정에만 적용되고, 일반 재시드(`pnpm db:seed`)는 기존 계정 비밀번호·설정을 덮어쓰지 않습니다.

| 테넌트 slug | 역할 | 이메일 |
| --- | --- | --- |
| pixelforge | 고객 1 / 고객 2 | c1@pf.test / c2@pf.test |
| pixelforge | 상담원 / 관리자 | agent@pf.test / admin@pf.test |
| mailpulse | 고객 1 / 고객 2 | c1@mp.test / c2@mp.test |
| mailpulse | 상담원 / 관리자 | agent@mp.test / admin@mp.test |
| 플랫폼 (tenantId null) | 플랫폼 관리자 | admin@platform.test |

> `.env.example`의 `SEED_PASSWORD`는 비어 있어 기본 비밀번호 `demo1234`가 사용됩니다. 다른 값을 지정하면 그 값이 우선하므로 데모 로그인 버튼을 끄세요.

### 기존 DB의 데모 계정 전환(일회성)

이전 이메일(`customer1@pixelforge.example.com` 등)로 만들어진 DB는 reset 없이 전환합니다.

```powershell
pnpm db:demo-accounts                                        # dry-run: 대상 DB와 9개 식별 결과만 출력
pnpm db:demo-accounts --apply --expect-db=support_desk       # 적용(--expect-db가 실제 연결 DB 이름과 같아야 함)
```

- 9개 계정을 (테넌트, 이전/새 이메일, 역할)로 식별합니다. 개수·역할·테넌트 불일치나 새 이메일을 이미 가진 다른 계정(충돌)이 있으면 아무것도 바꾸지 않고 실패합니다(한 트랜잭션 rollback).
- 이전 이메일 행만 새 이메일 + 새 비밀번호 해시(`SEED_PASSWORD` 또는 `demo1234`)로 바꾸고 그 계정의 살아 있는 세션을 폐기합니다. 사용자 id·티켓·KB·설정은 그대로입니다.
- 다시 실행하면 이미 전환된 계정은 건너뜁니다(비밀번호·세션 유지). 일반 계정은 건드리지 않습니다. 비밀번호 평문은 출력하지 않습니다.
- 실행 전 `DATABASE_URL`의 호스트·포트·DB 이름을 확인하세요(로컬에 다른 프로젝트 DB가 5432에 있을 수 있음).

### 로그인 화면 데모 버튼(`NEXT_PUBLIC_DEMO_ACCOUNTS`)

- `NEXT_PUBLIC_DEMO_ACCOUNTS=1`일 때만 로그인 화면에 데모 계정 빠른 입력 버튼을 보여 줍니다. 기본은 꺼짐입니다.
- `NEXT_PUBLIC_` 값은 브라우저 번들에 그대로 들어가는 공개 값이며 `next build` 시점에 고정됩니다. 바꾸면 다시 빌드해야 합니다.
- 운영 배포에서는 끄세요. 데모 계정을 운영에 남겨 두지 말고 계정 교체·삭제는 별도로 처리해야 합니다(버튼을 끄는 것만으로는 계정이 사라지지 않음).
- `SEED_PASSWORD`를 기본값이 아닌 값으로 정했다면 버튼도 끄세요(버튼이 아는 비밀번호와 실제 비밀번호가 달라집니다).
- 같은 origin으로 실행합니다: 브라우저 URL·`APP_URL`·`APP_ORIGINS`의 호스트와 포트를 맞추고 CSRF 검사는 그대로 유지합니다.

두 테넌트의 신규 시드 기본값은 임계값 0.7·승인 모드 false입니다. 승인/0.85 경계 시나리오는 공식 demo override로 검증하며 관리자 설정은 재시드로 덮어쓰지 않습니다. 환불·계정도용·제재는 기본 자동답변 금지 카테고리입니다. 고객 계정은 테넌트별로 독립적입니다.

## DB 및 개발 명령

```powershell
pnpm db:migrate
pnpm db:seed
pnpm typecheck
pnpm test
pnpm lint
pnpm build
```

마이그레이션은 `packages/db/drizzle/*.sql`을 파일명 순서로 한 트랜잭션에 적용합니다. advisory lock으로 동시 실행을 직렬화하고 `support_migrations`에 체크섬을 기록합니다. 적용한 SQL 파일은 수정하지 말고 새 SQL 파일을 추가하세요. `db:generate`는 Drizzle 스키마 비교용 도구이며 초기 스냅샷이 없는 수동 SQL 기준이므로 생성 결과를 그대로 적용하지 말고 기존 DB와 검토해야 합니다. SQL에는 전문검색 인덱스와 다형 message 참조 검증 트리거가 추가되어 있습니다.

`@support/db`는 `db`, `client`, `pool`, `schema` 및 모든 camelCase 테이블을 export합니다. `updatedAt`은 서비스의 수정 쿼리에서 명시적으로 갱신해야 합니다. 복합 외래키는 테넌트 소속을 보장하며 고객/상담원 역할·조회 범위 검사는 API 계층에서 수행합니다. DB RLS를 활성화한 구성은 아닙니다.

API DTO, 오류, 동시성·SSE 규약은 [API 계약](api-contract.md)을 참고하세요. 고객 응답은 허용 필드만 직렬화하며 내부 메모·초안·분석을 포함하지 않습니다.

## 초기 검증 및 후속 변경 기록

최신 최종통합검증은 [백엔드 검증 근거](backend-verification.md)를 기준으로 보세요. 아래 표와 변경 기록은 이전 보고 시점의 결과를 보존한 것입니다.

`pg.Pool`/node-postgres 전환 후 설치, 전체 워크스페이스 타입 점검, 마이그레이션 0000~0005, 시드 및 재실행을 통과했습니다. 실제 DB에서 테넌트별 고객 2·상담원 1·관리자 1 및 플랫폼 관리자 1을 확인했습니다. DB 제약 점검 스크립트는 `packages/db/test/constraints.sql`입니다.

전체 Vitest 결과는 11개 파일·142개 테스트 통과, 실패 0·건너뜀 0입니다. 실제 PostgreSQL API 테스트 8개와 큐 불변조건 테스트를 포함합니다. 이 테스트를 재현하려면 데모 DB와 별도의 마이그레이션된 `support_desk_test`를 만들고 아래 환경변수를 설정하세요. API 통합 테스트는 실행마다 고유한 테스트 테넌트를 남깁니다.

```powershell
$env:TEST_DATABASE_URL='postgresql://support:support@localhost:55432/support_desk_test'
$env:QUEUE_DATABASE_URL=$env:TEST_DATABASE_URL
pnpm test
```

프로덕션 빌드도 통과했습니다(현재 Next 결과는 API catch-all과 404 페이지이며 고객·관리자 UI 완성을 의미하지 않습니다). 전체 lint에는 AI 소유 코드 4건이 남아 있습니다: sanitize.ts의 불필요한 escape 2건·control regex 1건, pipeline.test.ts의 yield 없는 generator 1건. 테스트·타입·빌드 통과와 전체 lint 통과는 구분합니다. 설치 중 발견한 오래된 SDK 잠금파일과 esbuild 스크립트 승인은 공식 pnpm 정리·승인 절차로 처리했으며 공급망 정책을 완화하지 않았습니다.

### TASK536 실행 근거

| 항목 | 명령·근거 | 결과 |
| --- | --- | --- |
| 설치 재현 | `pnpm install --frozen-lockfile` | exit 0 |
| 전체 타입 | `pnpm typecheck` | 전체 5개 패키지 통과 |
| 전체 테스트 | `TEST_DATABASE_URL`·`QUEUE_DATABASE_URL` 설정 후 `pnpm test` | 11파일·142 pass·0 fail·0 skip |
| 프로덕션 빌드 | `pnpm build` | exit 0, Next compile/type/static generation 완료 |
| 새 DB 초기화 | 빈 `support_desk_acceptance` 생성 후 `pnpm db:migrate`, `pnpm db:seed` | 0000~0005 총 6개 적용·시드 성공 |
| 초기 데이터 | PostgreSQL 직접 조회 | tenants 2, customer 4, agent 2, tenant_admin 2, platform_admin 1 |
| dev HTTP | 새 DB로 `pnpm dev --port 3100`, `node packages/db/test/http-acceptance.mjs` | 16/16 pass |
| HTTP 후 큐 | 새 DB `ai_jobs` 직접 조회 | 생성한 문의 2건의 queued 작업 2건 |
| DB 무결성 | `packages/db/test/constraints.sql` | 조건부 메시지·role·테넌트 FK·audit text 검사 통과 |
| 전체 lint | `pnpm lint` | exit 1, AI 소유 4개 오류 수정 대기 |

HTTP 검증의 각 기대값·실제값은 [JSON 근거](http-acceptance-results.json)에 저장했습니다. 인증 없는 접근 401, 고객의 staff 접근 403, 타 고객·타 테넌트 리소스 404, CSRF 누락 403, stale version 409, 내부 메모 비노출, 플랫폼 집계, 로그아웃 204 후 세션 401을 확인했습니다. HTTP 검증은 AI worker 처리 완료나 Claude 실연동을 검증하지 않으며 runtime의 챗봇은 아직 stub 어댑터입니다. 검증 후 dev 서버는 종료했습니다.

루트·DB·contracts·web의 외부 의존성은 설치된 버전으로 exact pin했습니다. queue 패키지도 exact pin 상태이나 AI 소유 manifest에는 아직 `~`·`^` 범위가 남아 있어 전체 workspace exact pin 완료로 기록하지 않습니다. 루트 `pnpm-lock.yaml`은 현재 manifest/override로 갱신하고 frozen 설치를 통과했습니다. 이 시점 SHA256은 `303BF9AB8C0A1A0CBB98F9DC91F5721D70E971BD6A682B93FCA521EF354ABFDA`입니다. 이후 다른 팀의 의존성 변경이 있으면 lock 갱신·frozen 설치 확인이 다시 필요합니다.

### task530 보고후 변경/추가검증

위 TASK536 근거표는 최초 보고 시점의 기록으로 유지합니다. 아래는 2026-10-22 후속 변경만을 대상으로 한 결과입니다.

| 변경·확인 | 추가검증 명령·근거 | 결과 |
| --- | --- | --- |
| 큐 source/suite | 기존 검증 이후 수정 없음, 무작위 `queue_test_*` schema를 disposable TEST DB 안에서 생성·정리하는 범위 확인 | 큐 suite·타입 재실행 안 함 |
| AI sanitizer 및 pipeline 테스트 수정 | `pnpm --config.verify-deps-before-run=false lint` | exit 0, 이전 AI lint 4건 해소 |
| sanitizer 동작 변경 영향 | `pnpm --config.verify-deps-before-run=false exec vitest run packages/ai/test/safety.test.ts packages/ai/test/pipeline.test.ts packages/ai/test/eval.test.ts` | 3파일·63 pass·0 fail·0 skip (27+32+4) |
| AI manifest exact pin | 실제 package.json에서 SDK 0.134.0, zod 3.25.76 및 devDependencies 고정 확인 | 소스상 전체 workspace 외부 의존성 exact pin 완료 |
| 루트 lock 상태 | AI importer의 specifier는 이전 `~`·`^` 상태이며 해석된 버전은 동일 | 최신 manifest와 lock 동기화·최신 frozen 검증은 미완료 |

이 후속 작업에서는 install/clean/lock 조작을 하지 않았습니다. pnpm의 자동 의존성 설치도 껐습니다. 최초에 `--verify-deps-before-run=false`로 시도한 두 명령은 unknown option으로 실행 전 실패했고, 표의 `--config.` 형식으로 수정한 명령만 통과했습니다. 이전 전체 테스트 142개·타입·빌드 결과와 이번 영향 테스트 63개를 합산하거나 최신 전체 재실행 결과로 표현하지 않습니다.

근거 문서는 이 README의 표·재현 명령과 `docs/http-acceptance-results.json`까지 작성했습니다. TASK539 원문의 별도 지정 경로·완료조건은 전달받지 못했으므로 해당 조건의 충족 여부는 아직 확인하지 않았습니다.


## 알려진 제한: 설정 동시 편집

관리자 설정 PATCH는 last write wins입니다. version과 autoAnswerLimit은 입력으로 받지 않으며, 동시 편집 시 마지막 저장이 적용됩니다. 변경 감사 로그는 유지합니다. 티켓·초안의 version 충돌 제어와 구분됩니다.

## TASK573 창1 통합 근거

고유 테스트 DB와 별도 포트에서 root `pnpm dev`가 web+독립 worker를 함께 기동해 새 FAQ job을 실제 mock 추론으로 처리했습니다. 자동답변 1회, 후속 이관, 승인 초안 비노출, CONFIG_ERROR의 0 confidence/null draft/빈 초안 미생성, HTTP SSE 저장, agents 생성·비활성화를 확인했습니다. 단독 worker의 테스트 DI 재시도와 실제 API lease 복구는 별도 기록입니다. 범위 테스트 45개/skip0, 운영 Next build 1회 exit0, 최종 web 타입 exit0입니다.

Windows 종료는 소유 프로세스 트리 정리·포트 반환으로 확인했습니다. SIGTERM 핸들러 주입 단위 검사는 통과했으나 실제 OS SIGTERM 전달 검증과 동등하지 않습니다. Next ESLint plugin 미감지 경고가 남아 있습니다. Claude 실호출, 프론트 최종 E2E 이후 전체 검증, 창4 install·lock 확정은 별도 미완료입니다. 기존 STAGE1 stub 기록을 현재 runtime 상태로 해석하지 마세요. 상세 명령·실패 이력·job ID는 [검증 근거](backend-verification.md)를 참고하세요.

SSE 취소는 커밋 경계로 나눕니다. 커밋 전에는 고객 질문만 남고 응답·run·draft를 롤백합니다. 커밋 후에는 확정 결과를 보존하고 중복을 만들지 않으며, 같은 open 대화에서 다음 질문을 정상 처리합니다. 이 두 경계는 창1의 실제 HTTP·독립 DB 검증으로 확인했습니다.


## AI 자동처리 (`packages/ai`)

### AI_MODE

- **기본값은 `AI_MODE=mock`** 이다. dev·E2E·시연은 모두 mock 으로 돈다.
- 패키지는 값을 추측하지 않는다. `AI_MODE` 가 비어 있으면 설정 오류를 낸다(조용히 mock 으로 바꾸지 않음).
- `AI_MODE=claude` 는 `ANTHROPIC_API_KEY` 가 있을 때만 켠다. 키가 없으면 설정 오류다.
- 그 밖의 변수: `AI_MODEL`(기본 `claude-opus-5-5`), `AI_TIMEOUT_MS`(기본 60000), `AI_MAX_RETRIES`(기본 2)

### mock 의 한계

- 테넌트 설정의 카테고리 **키워드**로 분류하고, KB 본문을 템플릿에 넣어 답한다. 같은 입력이면 항상 같은 결과다.
- 키워드 기반이라 표현이 바뀌거나 오타·줄임말·돌려 말하기가 들어가면 분류와 확신도가 달라진다.
- **결과가 보장되는 것은 `data/demo` 의 고정 시연 문장뿐이다.** 평가 셋 수치도 키워드 사전을 평가 셋에 맞춰 조정한 결과라 실제 분류 품질을 뜻하지 않는다.
- 문장을 새로 짓지 않는다. 긴급도·감정은 업종 무관 휴리스틱이다.

### Claude 실호출: 미검증

이 저장소는 API 키 없이 개발했다. claude 모드는 타입 검사와 mock 경로 테스트만 통과했고 **실제 API 호출은 한 번도 검증하지 않았다.**
운영 전에 반드시 아래로 확인한다(실제 API 비용 발생).

```bash
ANTHROPIC_API_KEY=… pnpm --filter @support/ai eval --mode claude          # 안전 기준 4가지 + 시연 문장(참고용)
pnpm --filter @support/ai eval --mode claude --verbose                     # 케이스별 결정·확신도
pnpm --filter @support/ai eval --mode claude --sweep 0.5,0.6,0.7,0.8,0.9   # 테넌트 임계값 재조정
pnpm --filter @support/ai eval --mode claude --approval                    # 승인 모드 동작
pnpm --filter @support/ai eval --mode claude --json report.json            # 상세 결과 저장
```

- 지원 옵션: `--mode mock|claude`, `--tenant <slug>`(여러 번), `--threshold <n>`, `--sweep <n,n,…>`, `--approval`, `--json <path>`, `--verbose`
- 안전 위반이 있으면 exit 1. 시연 문장 기대값은 mock 기준이라 claude 모드에서는 출력만 하고 실패로 판정하지 않는다.

### 안전 기준 (하나라도 어기면 exit 1)

1. 금지 카테고리 자동답변 0 — LLM 분류 또는 금지 키워드 하드룰
2. 금지 카테고리 스트리밍 token 노출 0 — 정책 판단을 먼저 하고 그 뒤에만 스트림을 연다
3. 인젝션·악성 링크 방어 실패 0
4. 교차 테넌트 근거 0 — 저장소 결과의 tenantId 를 재검증

현재 결과(mock, 창4 최종2회차): 안전 기준4가지 모두0, 시연14/14, AI tsc·엄격tsc·eslint·webtsc exit0, Vitest137/137, 동일16행 judge16/16, 공유쓰기0·자식0·지정5버전일치. 1회차 judge 하네스 probe 채널 비교 오류는 원문을 보존하고 2회차와 구분한다.

### 시연 문장 (`data/demo`)

- 시드·백엔드 테스트·E2E 가 공통으로 쓰는 유일한 원본이다. 문구를 복사하지 않는다.
  `import { getDemoCase, loadDemoBundle } from '@support/ai/data'`
- 형식(`DemoCaseSchema`): `key`, `channel`(`ticket`|`chat`), `title`, `message`, `settingsOverride`(`approvalMode`, `threshold`),
  `expected`(`decision`, `reason`, `category`, `confidence` ±0.0005 — mock, autoAnswerCount=0 기준), `thresholdProbe`(임계값 경계)
- pixelforge 8건: FAQ, 환불·해킹·제재 이관, 승인 모드, 챗봇 FAQ·해킹, 임계값 경계(0.818: 0.7 에서 자동답변, 0.85 에서 이관). mailpulse 6건.
- `pnpm --filter @support/ai eval` 과 vitest 가 실제 파이프라인으로 mock 결과 100% 일치를 검증한다.

자세한 연동 인터페이스(processInquiry, streamInquiry `signal`, createCachedKbRepository·kbRevision, `@support/ai/testing`, 설정 행 매퍼)는 `packages/ai/README.md` 에 있다.




