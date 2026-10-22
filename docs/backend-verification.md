# 창4 최종소스 검증 (TASK591)

이 절은 아래 기준선·창1 중간 기록보다 최신이다. 제품소스/manifest 추가 변경 없이 검증했다. AI 최종2회차 원문 복사·해시일치 및 같은16행 기계16/16까지 확인했다. 아래 과거 대기/미완료 문구는 당시 기록이다.

| 항목 | 실제 명령 | 결과 | 근거 |
|---|---|---|---|
| 단독 설치 | pnpm install | exit0, Already up to date | [설치](verification/stage2/window4/install.log) |
| 전체 타입 | pnpm typecheck | exit0, 5 workspace packages | [최종](verification/stage2/window4/typecheck-after-fixes.log) |
| 전체 lint | pnpm lint | 최초3970오류 exit1 → 최소수정후 exit0 | [최초](verification/stage2/window4/lint.log), [최종](verification/stage2/window4/lint-final.log) |
| 실제 DB 포함 전체 test | pnpm test; TEST_DATABASE_URL/QUEUE_DATABASE_URL=소유 고유DB | 23파일271pass0fail0skip, exit0 | [원문](verification/stage2/window4/test-final.log) |
| 전체 build | pnpm build | 최초 sandbox EPERM exit1 → 권한승인 재시도0 → 수정후 최종1회0 | [최초](verification/stage2/window4/build.log), [재시도](verification/stage2/window4/build-escalated.log), [수정후 최종](verification/stage2/window4/build-final.log) |
| 새 빈 DB 재현 | pnpm --filter @support/db exec tsx test/window4-check.ts | 0000~0013 14migration+seed, 고객4/agent2/admin2/platform1 | [명령](verification/stage2/window4/runtime-command.log) |
| README root dev | apps/web cwd pnpm -w dev --port 3200 --hostname 127.0.0.1 | 실제 FAQ job c7ceb04a-5a84-495f-99fe-e7eaf25fca02, .865/public reply1 | [runtime](verification/stage2/window4/runtime-results.json), [서버](verification/stage2/window4/root-dev-final.log) |
| 종료 3종 | 소유 subtree/3200/pg_stat_activity | PID0/listener0/DB active0, COMMENT 확인 후 소유 DB만 DROP | 같은 runtime JSON |
| 프론트 최종 E2E | 별도 프론트 창3 실행 | expected61/unexpected0/skip0/flaky0 | [report](verification/stage2/e2e/report.json), [gates](verification/stage2/e2e/gates.txt), [check-end](verification/stage2/e2e/check-end.txt) |

설치 후 실제 AI 해석 SDK0.134.0/zod3.25.76/tsx4.23.15/vitest3.2.7/TypeScript5.9.3. rootlock SHA256 FB16B4D71EBBA019BBFF0E3783B63326BCEC171D739F88E9FA5F2AB4B48A1BB5, webmanifest SHA256 B76CC2E59C8D76D28FDDA04A08EBDE61F1245D235BEF1FE26E3206B2B9AB1CCF 모두 설치 전후 동일. [전](verification/stage2/window4/pre-install-hashes.json)/[후](verification/stage2/window4/post-install-hashes.json)/[실제 해석](verification/stage2/window4/ai-resolved.json).

lint 수정은 생성 Playwright HTML 자산만 제외, 검증파일 URL import/finally assertion, queue 테스트 unused binding 제거다. 일반 규칙 완화와 제품 동작 변경은 없다. 검증 harness/lint 보완 이후 최종 build1회를 추가 실행해 exit0을 확인했다. 제품 소스는 바꾸지 않았다. 최종 build 종료 후 [check-end](verification/stage2/window4/check-end.json)에서 listener0/dev-next-worker0, 앞선 runtime JSON에서 DB active0/소유DB DROP을 확인했다.

소유 DB support_window4_1792628504822_e2e만 생성/정리, 공유 support_desk_e2e 무접촉. Windows tree 종료의 자식 exit1을 전체 driver exit0과 구분한다. OS SIGTERM 전달 미검증. static-paths 운영 build 미재현/원인 미확정; Next ESLint plugin 경고는 숨기지 않았다.

[SSE 전체 단일실행 exit0·자동 done.ticketId/클릭 convert 응답·공개 source 예시](verification/stage2/task584-sse-report.md)는 창1 성공 근거다. [기존16행](verification/stage2/task579/demo-matrix.json)은 수동16/16 승인 후 창4 같은 JSON judge-16 기계16/16을 확인했다. probe는 ticket(probe @0.85, worker job)이며 재수집하지 않는다. AI 최종 원문은 [ai-eval.txt](verification/stage2/ai-eval.txt)에 편집 없이 저장했다. Claude 실호출은 미검증, axe serious/critical0·Lighthouse 미실행을 구분한다.


### AI 최종 원문·기계 대조

[최종2회차](verification/stage2/ai-eval.txt): AI tsc/엄격tsc/eslint/webtsc 전체 exit0, Vitest137/137, 안전0/demo14/14, 기존16행 기계16/16, 공유쓰기0/자식0/지정5버전일치. 16행 재수집·별도 judge 작성/실행은 하지 않았다. probe는 ticket(probe @0.85, worker job)이다.

[1회차](verification/stage2/ai-eval.run1.txt)는 부장 원문에 따라 SDK 버전 읽기 실패와 judge의 probe≠ticket 채널 판정 오류, 두 하네스 오류를 기록한다. judge exit1은 제품 판단값 실패와 구분한다. 최종2회차는 동일 자료의 올바른 채널 해석으로 exit0이다.

원본 <TEMP>/claude/E--portfolio-Support-Desk/f644a82d-3c78-4fad-aeef-b612b27ea73b/scratchpad/final/에서 편집 없이 복사했고 원본/복사 SHA256 일치:
- ai-eval.txt: 8A74993B7547BA575E36330E4CF7D66C46A5DF8261632B45ADCB1E22FE30D247
- ai-eval.run1.txt: 8825C0EDB19247A9D4606A8F64316CFF3918B6A17484E35B777C598E9315615C
---
# 백엔드 최종 통합검증 근거

## TASK573 창1 최신 실행 결과 (전체 최종검증과 구분)

창1 harness 최종 명령은 exit 0입니다. 실제 root pnpm dev + API bootstrap + mock worker로 새 job을 처리했고, HTTP SSE·DB 저장·agents PG를 검증했습니다. 테스트 전용 fault DI는 별도 worker 실행으로 구분합니다. 기존 kit15/branding 검증은 반복하지 않았습니다. 창4 최종 install/lock 및 프론트 최종 E2E 후 통합검증은 아직 미완료입니다.

| 항목 | 명령/결과 | 원문 |
| --- | --- | --- |
| API READY 후 web 타입 | node node_modules/typescript/bin/tsc -p apps/web/tsconfig.json --noEmit / exit0, 시작·최종 모두 | window1-web-typecheck.log |
| 범위 테스트 | queue/test + API postgres/conversations + contracts public / 6파일45pass0fail0skip | [범위 원문](verification/stage2/window1/attempt2/scoped-tests.log) |
| 고유 새 DB·seed | support_window1_1792623379811_e2e / 0000~0012 13migration+seed 실제성공 | [최종 명령](verification/stage2/window1-command-5.log) |
| 실제 root dev | port1871, web+독립 worker, 기본 API bootstrap, 실제 mock 추론 | [dev](verification/stage2/window1/dev.log) |
| FAQ 신규 job | 7d75aacc-50fa-486d-8de7-0bc2ab4ac81d / auto_answer/confident_kb_match/install/.865/public1 | [JSON](verification/stage2/window1/results.json) |
| 후속·승인 모드 | 후속 공개1유지/이관; approval 새 job 1a822e1f-c321-4fcc-8f47-1c243839f920 pending_approval/approval_mode/.865/draft1/고객0 | 같은 JSON |
| 실제 CONFIG_ERROR | 새 job5da2bd27-da62-49d5-91ec-32b64a5d1b38 / attempts1,confidence0,원본 aiResult.draft null,DB draft0/public0 | 같은 JSON |
| 실제 HTTP SSE/DB | classified/sources/token*/done IDs, assistant저장1/내부분석누출0 | 같은 JSON |
| agents 실제 HTTP·PG | 중첩201/중복409/list/disable200/reactivate400 | 같은 JSON |
| worker 단독 DI 재시도 | test-only wrapper로 일시실패2회후이관/draft0; production hidden env 없음 | [단독worker](verification/stage2/window1/standalone-worker.log) |
| 실제 API lease 복구 | ee11b907-e572-4653-b8d5-4da37756461f / 실제 기본processor 성공,메시지1/중복0; stale fencing은 실제PG queue suite도검사 | JSON 및 범위로그 |
| 운영 build 1회 | pnpm --config.verify-deps-before-run=false --filter @support/web build / exit0 | [build](verification/stage2/window1/production-build.log) |
| SIGTERM 핸들러 주입 | node scripts/signal-handler-check.mjs / exit0,등록핸들러호출/자식종료확인 | [단위로그](verification/stage2/window1/signal-handler-unit.log) |
| Windows 실제 종료 | 소유 taskkill tree/port반환/대상연결0, root·worker 종료code1. OS SIGTERM전달 미검증 | JSON |
| 소유 DB 정리 | 랜덤COMMENT·정확생성명·연결0확인후DROP; 공유DB무접촉 | JSON cleanup |

Next dev 초기 실패는 queue 내부 .js specifier를 .ts로 해석하지 못한 module-not-found였습니다. 소유 next.config.ts webpack extensionAlias로 보완했고 새 실행에서 통과했습니다. 최초 npm_execpath 미제공, 테스트 전용 queue import 위치 오류, CONFIG_ERROR JSON의 원본이 adapter envelope aiResult 안에 있는데 잘못 읽은 검증 오류는 각각 실패로 기록했습니다. 원본 schema null 기대를 완화하지 않고 AIRunResultSchema.parse(result.aiResult)로 검증했습니다. 각 시도 로그와 attempt2/3/4 디렉터리를 보존합니다.

운영 build 경고는 Next ESLint plugin 미감지 1건입니다. rule 완화·경로 제외·추가설치로 숨기지 않았습니다. 이 경고는 Error stack을 제공하지 않았고, 초기 module-not-found의 import trace는 attempt2/dev.log에 있습니다. 현재 재현에서 별도 정의 관련 warning/stack은 관찰되지 않았습니다.

잔여: aiRuns의 ticket/conversation XOR와 최종 job/conversation 출처모델 차이는 q_550bed9e1e41로 확인 요청 중이며 임의완료로 처리하지 않습니다. 후속 프론트 E2E/창4 최종 install·전체검증은 이 결과와 분리합니다.


## STAGE2 TASK553 기준선

이 절은 이전 STAGE1 검증과 분리합니다. 새 정식착수 승인 후 기존 installer 프로세스가 없음을 확인하고 비-frozen `pnpm install`을 **1회** 실행했습니다. exit 0, 설치 오류 없음이며 원문은 [STAGE2 설치](verification/stage2/install.log)입니다. root lock SHA256은 `FB16B4D71EBBA019BBFF0E3783B63326BCEC171D739F88E9FA5F2AB4B48A1BB5`입니다.

DB 시드가 AI 데이터의 단일 원천을 읽도록 `packages/db`에 `@support/ai: workspace:*`를 추가해 이 설치에 포함했습니다. AI/queue/web의 현 exact manifest도 통합 설치에 반영됐습니다. 이후 install/clean/lock 조작은 별도 승인이 필요합니다. 이 기준선은 STAGE2 구현·전체 테스트·프론트 E2E 통과를 의미하지 않습니다. 프론트 실행과 조정 전에는 전체 검증을 실행하지 않습니다.

STAGE2 소단위 근거: web 단독 `node node_modules/typescript/bin/tsc -p apps/web/tsconfig.json --noEmit` exit 0/진단 없음. DB·contracts 타입 및 소유 범위 lint도 통과했고, 공개 SSE 경계 4개·reset 대상 보호 10개 총 14개 테스트가 통과했습니다. 이는 전체 검증 결과가 아닙니다. 계약/DB 변경은 0006(settings categories·limit·fallback, KB revision/question), 0007(conversation reason/noticeCode) 전진 마이그레이션이며 아직 실제 DB 적용 검증 전입니다.

확정된 실행 경계로 root dev/worker wrapper와 loadSeedBundle/loadDemoBundle 기반 시드를 구현했습니다. worker의 API 소유 `worker-bootstrap.ts`는 최초 조회 때 아직 없었으며, 실제 기동 가능 여부는 파일 준비 후 전체 조정된 검증에서 확인합니다. 미승인 상태로 재분류한 것이 아니라 구현 의존성의 당시 파일 상태입니다. task553은 demo 멱등성·관리자 설정 보존·reset 실DB·web/worker 종료 전파 등의 최종 실행 검증 전에는 완료로 기록하지 않습니다.

2026-10-22 최종 재개 승인 후 실행한 결과입니다. 기존 task530/536의 중간 결과를 최종 실행 결과로 재사용하지 않았습니다. 현재 판정은 **부분 완료**입니다. 전체 lint에 프론트 소유 오류 1건이 남아 있으며 최종 build는 그 수정 후 실행 대기입니다.

## 실행 범위와 환경

- Node.js 24.14.1, pnpm 11.25.0, Next.js 15.5.28, Docker Engine 29.4.0.
- 기존 pnpm 설치 프로세스가 없음을 확인한 뒤 승인된 비-frozen `pnpm install`을 **1회** 실행했습니다. clean·추가 설치·의존성 정책 완화는 하지 않았습니다.
- 이후 pnpm 명령은 `--config.verify-deps-before-run=false`로 자동 설치를 막았습니다.
- PostgreSQL은 프로젝트 Compose의 55432 포트입니다. 기존 5432 서비스에는 손대지 않았습니다.
- 새 빈 DB `support_desk_final_20261022`를 생성하여 0000~0005를 적용하고 시드했습니다. 기존 개발 DB `support_desk` 및 과거 검증 DB와 구분합니다.
- 큐 suite는 이 disposable DB 안에 이번 실행이 생성한 `queue_test_62653acbec994ae6a5ecf97b720f4067` schema만 사용·정리했습니다. 기존 schema 또는 DB를 삭제하지 않았습니다.
- 환경변수·비밀번호·세션 토큰은 로그에 출력하지 않았습니다. 문서의 DB명·포트는 비밀값이 아닌 검증 대상 식별자입니다.

## 명령별 결과

환경변수 이름만 기재합니다. 실제 연결문자열은 실행 환경에서 주입했습니다.

| 항목 | 실행 명령 | 결과 | 원문 근거 |
| --- | --- | --- | --- |
| 설치 | `pnpm install` | exit 0, 6 workspace projects | [설치](verification/final-install.log) |
| 전체 타입 | `pnpm --config.verify-deps-before-run=false typecheck` | exit 0, AI/queue/DB/contracts/web 전체 통과 | [타입](verification/final-typecheck.log) |
| 전체 lint | `pnpm --config.verify-deps-before-run=false lint` | exit 1, 프론트 미등록 Next 규칙 참조 1건 | [실패 원문](verification/final-lint.log) |
| Docker | `docker compose up -d --wait` (`POSTGRES_PORT=55432`) | exit 0, healthy | [Docker](verification/final-docker.log) |
| 새 DB 마이그레이션 | `pnpm --config.verify-deps-before-run=false db:migrate` | exit 0, 0000~0005 총 6개 처음부터 적용 | [마이그레이션](verification/final-migrate.log) |
| 새 DB 시드 | `pnpm --config.verify-deps-before-run=false db:seed` | exit 0 | [시드](verification/final-seed.log) |
| 전체 테스트 | `TEST_DATABASE_URL`, `QUEUE_DATABASE_URL` 설정 후 `pnpm --config.verify-deps-before-run=false test` | exit 0, **11파일·145 pass·0 fail·0 skip** | [테스트](verification/final-test.log) |
| DB 제약 | `constraints.sql`을 새 DB에서 psql로 실행 | exit 0, 검사 후 rollback | [제약](verification/final-db-constraints.log) |
| 계정·확장·FK | psql 읽기 조회 | 계정 수 일치, vector 존재, 고아 참조 0 | [DB 조회](verification/final-db-evidence.log) |
| cwd별 환경파일 | `node packages/db/test/env-cwd.mjs` | 수정 재시도 exit 0, 3 cwd 모두 루트 .env 탐색 | [최종](verification/final-env-cwd-retry.log), [첫 시도](verification/final-env-cwd.log) |
| dev 기동 | 새 DB 연결 후 `pnpm --config.verify-deps-before-run=false dev --port 3100` | ready 후 HTTP 응답 확인, 검증 후 직접 시작한 프로세스 종료 | [dev](verification/final-dev.log) |
| 실제 HTTP | `node packages/db/test/http-acceptance.mjs` | 수정 재시도 exit 0, **16/16 pass** | [최종](verification/final-http-retry.log), [JSON](verification/final-http.json), [첫 시도](verification/final-http.log) |
| manifest/lock | 6 manifest와 root lock의 직접 specifier 대조 | 63개 일치, 외부 의존성 모두 exact pin | [대조](verification/final-lock-consistency.log) |
| 최종 build | `pnpm --config.verify-deps-before-run=false build` | 프론트 lint 수정 후 실행 대기 | 미실행 |

테스트의 `queue down`/`boom` stderr는 강제 실패 시 롤백을 검증하는 케이스의 의도된 출력입니다. 성공/실패 판정은 Vitest의 최종 집계와 exit code로 했습니다.

## acceptance와 테스트 매핑

| acceptance | 테스트 파일·케이스 | 이번 근거 |
| --- | --- | --- |
| 로그인·세션 해시·만료·CSRF·역할 제한 | `apps/web/src/server/__tests__/auth.test.ts` (19개) | 전체 테스트 pass, HTTP 로그인/HttpOnly/CSRF/로그아웃 검증 |
| 고객·테넌트 격리·본문 비노출 | `isolation.test.ts` (13개), `postgres.integration.test.ts` | 실제 DB 및 HTTP에서 타 고객·타 테넌트 404, 다른 tenant 경로 세션 401, 고객 staff 접근 403 |
| 문의·메시지·큐 원자성·내부 메모 | `tickets.test.ts` (16개), PostgreSQL 통합 | enqueue 실패 시 ticket/message rollback, HTTP 내부 메모 비노출 |
| 대화·SSE·티켓 전환 | `conversations.test.ts` (6개), PostgreSQL 통합 | 대화 변환 중복 방지 등 pass. 서비스 runtime 챗봇은 stub이므로 실제 AI 스트리밍 완료 증거는 아님 |
| 실제 PostgreSQL API | `postgres.integration.test.ts` (8개) | enqueue, rollback, 세션, IDOR, 승인 경쟁, version 409, 대화 전환 경쟁, KPI SQL 모두 pass |
| 큐 기본 동작·실제 DB 불변조건 | `packages/queue/test/queue.test.ts` (2개 top-level tests) | 실제 DB suite 활성, skip 0. 아래 12개 내부 check 포함 |
| AI 계약·안전·정책·평가 | `packages/ai/test/{contracts,safety,pipeline,eval,config}.test.ts` | 각각 12+27+32+4+6 = **81 pass** |

API 테스트 합계는 62개, 큐는 2개입니다. AI 81개와 합쳐 최종 145개이며 내부 check를 top-level 테스트 수에 중복 합산하지 않았습니다.

큐의 실제 DB suite는 멱등 enqueue/호출자 rollback, concurrent SKIP LOCKED claim, lease 복구와 stale worker 차단, 최종 재시도 실패 이관, 자동답변 1회 제한, messageId null 재생성의 공개발송 금지, result JSON과 개별 분석 컬럼/0토큰/context 매핑, 최신 분류 보존과 누락 분석 null, 승인 모드 강제, resolved/closed 불변, 사람 답변 이후 AI 억제·승인409·실패 rollback, conversation target 결과 저장을 검사합니다.

## 승인 경쟁과 FK의 현재 상태

현재 API source는 티켓 잠금 → 메시지 INSERT → version/status 조건부 draft UPDATE 순서입니다. 0005를 선택했던 당시의 UPDATE 선행 구현과 구분합니다. 기존 적용 마이그레이션을 다시 쓰거나 되돌리지 않았습니다.

- `ai_drafts_sent_tenant_fk`, `ticket_messages_draft_tenant_fk`는 tenant_id를 포함한 복합 FK이며 둘 다 DEFERRABLE INITIALLY DEFERRED입니다.
- PostgreSQL 통합 테스트는 승인 결과 `[200,409]`, 메시지 1건, draft `sent`, version 2, sentMessageId 일치를 검사했습니다.
- 이번 새 DB에서 커밋 후 양방향 고아 참조 0건을 조회했습니다. 참조 무결성을 제거하거나 FK를 삭제하지 않았습니다.

## lock·lifecycle 및 과거 실패의 구분

최종 루트 lock SHA256: `0278FAB00243F35E09F363A4F26CD222D569991292E06DBE0DB722B05C3D01A7`. 승인된 이번 설치로 AI/queue를 포함한 6 manifest의 63 직접 specifier가 lock과 일치함을 확인했습니다. **이번에는 frozen 설치를 추가 실행하지 않았습니다.** README의 과거 frozen 성공은 이전 lock의 중간 근거입니다.

과거 `pnpm clean --lockfile`은 패키지별 node_modules와 AI 패키지 lock도 제거했습니다. 별도 백업은 만들지 않았습니다. 이번 최종 실행에서는 clean이나 AI 소유 파일 변경을 하지 않았습니다. 과거 SDK 0.137.0 정책 거부의 published는 `2026-10-20T22:18:00.000Z`, cutoff는 `2026-10-20T20:23:00.025Z`였습니다. 현재 SDK는 소유팀이 exact pin한 0.134.0입니다.

과거 `pnpm approve-builds`에서 esbuild를 선택하고 확정하여 postinstall을 실행했습니다. 정책 변경은 `pnpm-workspace.yaml`의 `allowBuilds.esbuild: true`이며 이번에 다시 승인하거나 설정을 완화하지 않았습니다. 설치된 세 버전 모두 postinstall 명령은 `node install.js`입니다.

| esbuild | 공개 npm 배포시각(UTC) | 경로 |
| --- | --- | --- |
| 0.18.20 | 2023-08-08T04:15:59.940Z | drizzle-kit → esbuild-kit |
| 0.25.12 | 2025-11-01T23:36:22.605Z | drizzle-kit/queue의 tsx 등 |
| 0.28.2 | 2026-08-08T20:00:55.454Z | AI/DB의 tsx 및 vite 등 |

조회 근거: [pnpm why](verification/final-esbuild-why.log), [npm UTC 메타데이터](verification/final-esbuild-release-times.log). 이 조회는 lifecycle 실행이나 추가 설치가 아닙니다.

cwd probe 첫 시도는 검증 자식 프로세스의 tsx 로더 해석 문제로 실패했습니다. DB 패키지의 절대 loader 경로를 사용한 재시도만 pass입니다. 실제 루트/`packages/db`/`apps/web` cwd에서 marker를 읽었고 Pool을 닫았습니다. 기존 .env는 덮어쓰지 않았으며 생성한 marker 파일은 제거했습니다.

HTTP 첫 시도는 같은 disposable DB에 테스트 fixture 테넌트가 추가된 후에도 총 테넌트를 2개로 가정하여 실패했습니다. 제품의 플랫폼 집계는 전체 테넌트를 반환하므로 검증 스크립트를 시드 slug 2개의 존재와 본문 비노출 검사로 수정했습니다. 재시도 16개만 pass로 집계했습니다. 기존 `docs/http-acceptance-results.json`은 보존했습니다.

## worker·stub 제한과 미완료 항목

- 큐 suite는 실제 DB에서 주입한 테스트 processor와 `InquiryQueue.runOnce()`를 실행했습니다. 서비스의 상시 worker 프로세스를 기동한 증거는 아닙니다.
- `apps/web/src/server/runtime.ts`의 챗봇은 `stubChatResponder`입니다. 실제 AI 패키지 어댑터·Claude 실연동·운영 worker polling/heartbeat 배포는 이번 완료 범위가 아닙니다. HTTP 문의가 enqueue됐다는 사실을 AI 답변 처리 완료로 표현하지 않습니다.
- 서비스 worker 실행 예시는 `packages/queue/README.md`의 processor 주입 및 runOnce/heartbeat 지침을 참고합니다. 실제 AI 연동과 worker 호스팅은 다음 단계입니다.
- 현재 최종 lint 실패: `apps/web/src/components/tenant-context.tsx:69:9`, 미등록 `@next/next/no-img-element` 규칙 참조. 프론트 담당팀에 전달했고 임의 수정·일반 규칙 완화·추가 설치를 하지 않았습니다.
- 이 lint 수정 후 lint를 재검증하고 최초 최종 build를 실행해야 전체 완료로 판정할 수 있습니다. 기존 task539/541의 done 상태 자체는 이 문서의 실행 증거가 아닙니다.

## 후속 우선지시: 소유 의존성 cutoff·exact pin 점검

최종 검증 이후 별도로 승인된 의존성 점검입니다. `package.json`, `apps/web/package.json`, `packages/contracts/package.json`, `packages/db/package.json`만 대상으로 삼았습니다. 설치·clean·lock 갱신·AI/queue manifest 변경은 하지 않았습니다.

- 외부 직접 패키지 37개 고유 name/version 및 packageManager `pnpm@11.25.0` 1개, 총 **38개**의 공개 npm 배포시각을 대조했습니다. 모두 이미 exact pin이어서 manifest 수정은 필요하지 않았습니다.
- config get의 minimumReleaseAge 값은 undefined였으나 설치된 pnpm source의 기본 `minimum-release-age`는 `24 * 60`분입니다. 확인 시각 `2026-10-21T20:57:40Z`에서 24시간을 뺀 잠정 cutoff `2026-10-20T20:57:40.000Z`를 사용했습니다. 별도 부장 고정 cutoff 확인은 요청한 상태입니다.
- 더 이른 과거 실제 정책 오류의 cutoff `2026-10-20T20:23:00.025Z`에도 **38개 모두 적합**했습니다. metadata 오류·timestamp 누락·cutoff 위반은 0입니다. 정책 설정을 바꾸거나 예외를 추가하지 않았습니다.
- npm registry 원문 출처 URL, owners, 각 버전의 UTC publishedAt, 두 cutoff 판정은 [구조화 근거](verification/dependency-cutoff.json)에 있습니다. 검사 스크립트는 `packages/db/test/dependency-cutoff.mjs`입니다.
- pnpm 11.25.0의 배포시각은 `2026-08-29T14:17:49.954Z`입니다. packageManager도 cutoff에 적합하며 이번에 설치하거나 실행 버전을 교체하지 않았습니다.

이 점검 결과는 프론트 lint 또는 최종 build의 성공 증거가 아닙니다. 해당 미완료 상태는 그대로 유지합니다.

### STAGE2 추가 범위 검증: SSE 영속성 보강

- 기준선 install은 docs/verification/stage2/install.log의 exit 0이며 이후 install/clean/lock 변경 없음.
- 공개 contracts 5 + reset 안전검사 10 = 15 pass / 0 fail / 0 skip (전체 검증 아님).
- 0008 추가 후 `node node_modules/typescript/bin/tsc -p packages/db/tsconfig.json --noEmit` 및 contracts 동일 명령 각각 exit 0.
- 0008은 kb_revision, nullable SSE jobId, run 멱등 부분 UNIQUE, draft conversation 대상/기존 run 승계를 추가. migration 실제 적용 및 PostgreSQL 동작검증은 아직 미실행. 기존 STAGE1 결과와 합산하지 않음.

### STAGE2 최종 계약 정정 추가검증

- sources `{id,title,excerpt?,url?}` (url null 불가), public categories `{id,label}[]`, admin CategoryDef 유지. system reason/noticeCode 3종 계약 유지.
- 0009에서 autoAnswerLimit CHECK=1, fallback 임의 기본값 제거/유효 id 정책, KB 개별 revision 제거. AI 원본 두 settings.json fallback은 other/limit은1임을 읽어 확인. 실제 DB 적용은 미실행.
- 변경 후 DB/contracts 직접 tsc 각각 exit0, 변경 소유파일 eslint exit0, 공개계약6+reset10 =16pass0fail0skip(전체 아님).
- web 단독 `node node_modules/typescript/bin/tsc -p apps/web/tsconfig.json --noEmit` exit1: helpers.ts:28 kbRevision optional TS2322; repo/drizzle.ts:588 KbPatch 미정의 TS2304; routes/admin.ts:113 question 누락 TS2345. API팀 전달, 소유코드 미수정.

### STAGE2 실제 DB 적용 및 web 재검증

- 최신 web 단독 tsc exit0. 이전 API3오류와 이후 fallback/revision 오류는 현재 통과로 갱신합니다.
- `pnpm --config.verify-deps-before-run=false --filter @support/db exec tsx test/stage2-db-check.ts`: 최초 .env 부재로 exit1(DB 생성 전), 공개 .env.example+확인된Docker55432 사용 후 sandbox EACCES exit1, 동일 명령 require_escalated 실행 실제 exit0.
- 독립 새 빈 DB support_stage2_1792621692976_e2e에 0000~0010 총11 migration 적용 후 seed exit0. 기존 DB/schema 삭제 없음. pixelforge/mailpulse 각4계정 확인. 검증용 tenant/고객/대화/티켓은 이 독립DB에 보존.
- 실제 SQL 통과: 동일 SSE draft에 ticketId 추가 후 conversationId/runId/body 보존, jobId NULL; job없는 run messageId 필수; 대상 XOR; 동일message/pipeline 중복23505; draft job/conversation 출처XOR; conversation중복23505; autoAnswerLimit0 거부23514.
- 0009의 미적용 revision DROP은 제거하여 kbArticles.revision 보존. 0010은 잘못된 ticket/conversation XOR를 job/conversation 출처XOR로 전진 보완. tenantSettings.kbRevision은 별도 캐시 revision.

### STAGE2 0011 threshold double precision 정규화

- 승인 정책: `ALTER COLUMN ai_threshold TYPE double precision USING round(ai_threshold::numeric,4)::double precision`. 기존 float4 값을 소수 4자리로 정규화하여 변경하는 정책이며 기존값 보존이라고 간주하지 않음. mapper 반올림/기대 완화 없음.
- 소유 독립DB support_stage2_1792621692976_e2e에서 STAGE2_DATABASE_NAME 지정/RUN_AI_KIT=1로 stage2-db-check.ts 실제 exit0. 0011 적용으로 누적12 migration, seed exit0, AI DB kit15pass0fail0skip(KB8/Settings5/revision2). 이번 실행은 기존 독립DB에 전진 적용이며 새빈DB 재현으로 주장하지 않음.
- information_schema ai_threshold double precision 확인, 기존행 threshold 표시전후0.7/0.7. 원래보이는 값이 같아도 4자리 정규화 정책은 적용됨.
- 전체 schema 실수형: tenantSettings.aiThreshold double precision, aiRuns.confidence double precision뿐이며 잔여 real/numeric 없음. confidence 원본 JSON final 비교10건/불일치0. confidence 정규화 자동확대 없이 현 타입/정밀도 유지 제안.

### STAGE2 공유 DB 무접촉 및 branding/sources 실제 검증

- 기존 stage2 원문명령/스크립트/로그 대조: support_desk_e2e 대상 drop/reset/migrate 없음. stage2-db-check.ts는 URL pathname을 소유 support_stage2_1792621692976_e2e로 교체한 뒤에만 Pool/seed/migrate 사용하며 --reset 호출 없음.
- `pnpm --config.verify-deps-before-run=false --filter @support/db exec tsx test/branding-sources-check.ts` require_escalated 실행. 최초 support_branding_1792622032613_e2e는 DTO Date의 HTTP JSON 직렬화 단계를 검사코드에서 생략하여 exit1, DB 소유검증/정리 완료. API 기대를 완화하지 않고 실제 HTTP 직렬화 후 schema 검사하도록 수정.
- 최종 support_branding_1792622047192_e2e에 새빈DB부터 0000~0012 13migration+seed 성공, 명령 exit0. PF#7c3aed/MP#2563eb DB→toPublicSettings 검증, public categories id/label만, 내부prompt 제외 확인.
- 양 tenant 자동답변 공개 sources DB 저장 허용목록/실제 toCustomerMessage SourceSchema 검증, tenantId/score/confidence/classification/reasonDetail/summary 미포함. 외부tenant source 제외 및 내부분석 projection 제거 확인. system DB reason→public escalationReason+noticeCode/HTTP JSON schema 확인. 재seed 후 관리자 색상 #123456 보존 확인.
- 두 신규 DB 모두 매 실행 랜덤 ownership COMMENT/정확 대상명/자기 Pool 종료/남은 연결0 확인 후 자신의 DB만 DROP. 공유 DB 및 기존 DB/schema 삭제 없음, 강제 연결 종료 없음.
- 변경 후 DB/contracts tsc exit0, 소유변경 eslint exit0, 제한18tests pass0fail0skip. 전체검증과 구분. install/clean/lock 변경 없음.

### STAGE2 최신 컴파일 및 비_e2e 독립 DB 재현

- 현재 `node node_modules/typescript/bin/tsc -p apps/web/tsconfig.json --noEmit` exit0(no output), 과거 SSE exit2와 구분.
- 실제 schema 대조: tenantSettings 16컬럼(kbRevision NN default0), autoAnswerLimit CHECK=1, aiThreshold double precision. 기존 적용 migration 재작성 없음.
- 요청된 비_e2e 새 support_kit_1792622188564_verify DB에서 0000~0012 13migration+seed 실제 exit0, mailpulse/pixelforge 각4계정 확인, DB AI 적합성키트15pass0fail0skip. 원문 docs/verification/stage2/non-e2e-kit.log. 코드구현과 실제실행을 구분.
- 자기 생성명/랜덤소유COMMENT/모든소유Pool 종료/대상연결0 확인 후 해당DB만DROP. 공유support_desk_e2e 무접촉.
- pnpm dev:web 기준선용 README 설명추가. 서버·worker·E2E 기동 없음. rootwrapper 추가의존성/manifestlock변경없음.

## TASK573 창1 재개: 진행 중

창1은 기존 기준선/중간 결과와 별도입니다. PublicSource schema 편집은 API 담당자에게 한시 이관하여 동시 편집하지 않습니다. API READY 확인 전 web tsc·Next 기동·DB 통합검증은 아직 시작하지 않았습니다.

settings PATCH strict 입력은 version/autoAnswerLimit 제외로 정정했습니다. 관리자 동시 편집은 last write wins이며 감사 로그 유지입니다. agents POST는 중첩 agent+temporaryPassword, PATCH는 disabled-only입니다. seed는 공식 tenantSettingsToRow 뒤 branding 병합을 사용하며 기존 설정을 보존합니다. 코드를 수정한 상태와 창1 실제 DB/worker 실행 성공을 구분합니다.

추가 install/clean/lock 변경 없음. 기존 kit15/branding 결과를 반복하지 않습니다. worker SIGTERM·운영 build·최종 E2E 후 검증은 아직 완료로 간주하지 않습니다.

## TASK573 창1 abort 최종 경계 추가검증

`pnpm --config.verify-deps-before-run=false --filter @support/db exec tsx test/abort-boundaries-check.ts` 실제 exit0. 새고유 support_abort_1792623740375_e2e/별도port7314/실제API dev:web 사용. 기존build와통과한45범위·kit15·branding은반복하지않음.

- API conversations.test.ts `-t "abort 경계"`: 2pass/0fail/17skip. 17개는명시name filter 비대상이며 pass에합산하지않음.
- 실HTTP DB 커밋전 취소: ai_runs INSERT의 테스트DB전용advisory gate 대기확인후연결취소/lock해제. user1/assistant0/run0/draft0.
- 실HTTP DB 커밋후 취소: done수신후취소. user1/assistant1/run1/draft0보존,기존messageID유지,추가중복assistant0,같은대화후속요청200.
- cleanup은생성명/랜덤소유COMMENT/자기연결종료/target연결0확인후해당DB만DROP. 공유DB무접촉. production테스트env권한추가없고 DBgate도오직자기검증DB에만생성·삭제.
- 마지막webtsc exit0. 설치/clean/lock추가없음. 원문 [abort명령](verification/stage2/abort-command.log), [API테스트](verification/stage2/abort/api-tests.log), [실행JSON](verification/stage2/abort/results.json), [HTTP서버](verification/stage2/abort/dev-web.log).

## TASK579 4단계 창1 중간 근거

STORAGE_READY: 0013 출처 모델 전진 적용·불명행 거부/유효행 보존과 최신 aiResult/null/heartbeat 영향22test 및 incremental false web타입이 실제 통과했습니다. 금지 SSE·중복 전환·worker0·system metadata, 실제15초 heartbeat, agents 감사 원자성·세션·격리·배정·목록, apps/web cwd root seed/reset/dev는 실행별 근거로 구분합니다. 상세 [TASK579 중간 표](verification/stage2/task579-progress.md).

16행 대조는 AI eval14 확정 신호 대기이며 아직 실행하지 않았습니다. exact PID/listener 및 서버 stdout 비밀번호 직접 대조 보강은 그 실행에 포함할 준비 상태입니다. task done/전체 최종 완료로 간주하지 않습니다. 이번 install/lock/전체build 반복은 없습니다.

## TASK584 창1 중간 근거 추가
현재 수정 SSE harness 전체 한 실행 exit0 및 종료 PID/listener/DB active0, 마지막 web tsc0을 확인했다. [항목별 명령/assert/실제값 표](verification/stage2/task584-sse-report.md). 과거 attempt2 실패·부분 성공과 분리한다. 16행은 재수집 없이 수동16/16 승인 근거를 유지하며 창4 같은 JSON judge-16 기계 대조는 미완료다. static-paths는 기존 운영 build 미재현/원인 미확정이다. 창1 종료 후 창2·3 Next/공유 쓰기를 중지하고 창4 별도 공지를 기다린다. 최종 통합 완료 보고가 아니다.




