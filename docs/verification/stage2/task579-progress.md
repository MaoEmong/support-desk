# TASK579 창1 중간 검증 근거

최종 전체 완료 보고가 아니다. 기존 build/45 suite/kit15/branding/abort는 반복하지 않았다. install/clean/lock 변경은 없다. 16행 대조는 AI eval14 확정 신호 대기 중이다.

## 실제 실행과 assert 매핑

아래 경로의 assert 위치는 `packages/db/test/` 기준이다. HTTP 명령은 `pnpm --config.verify-deps-before-run=false --filter @support/db exec tsx test/task579-check.ts`이며, 내부에서 **apps/web cwd**의 `pnpm -w db:seed --reset`, `pnpm -w dev --port 3200 --hostname 127.0.0.1`을 실행했다. pnpm CLI는 설치된 JS 경로를 명시했고 새 사본을 설치하지 않았다.

| 항목 | 실제 명령/범위 | assert 파일:줄 | 실제값 / 기대값 | exit | 로그 |
| --- | --- | --- | --- | --- | --- |
| 최초 web 타입 | `node node_modules/typescript/bin/tsc -p apps/web/tsconfig.json --noEmit --incremental false` | TypeScript 진단 | 출력 없음 / 진단 0 | 0 | 도구 실행 원문, 아래 최종 타입 기록과 구분 |
| aiResult/null/heartbeat 최신 영향 | `pnpm ... exec vitest run apps/web/src/server/__tests__/ai-run-result.test.ts apps/web/src/server/__tests__/conversations.test.ts` | `ai-run-result.test.ts`, `conversations.test.ts:163` | 3+19=22 pass / fail0 skip0 | 0 | [영향 테스트](task579-result-tests.log) |
| 0013 기존 행 조사·보존 | `pnpm ... --filter @support/db exec tsx test/run-source-migration-check.ts` | `run-source-migration-check.ts:46` | 불명출처는 raise/rollback, 2행 유지, ledger 미추가 / 동일 | 0 | [출처 검증](task579-run-source.log) |
| 0013 유효 출처 적용 | 위 명령 | `run-source-migration-check.ts:52` | 기존 worker1/SSE1 보존 / 동일 | 0 | 같은 로그 |
| run 출처·변환·중복 | 위 명령 | `run-source-migration-check.ts:58` | 같은 id/conversation/message/pipeline 유지+ticket 추가, XOR/worker ticket 거부23514·중복23505 / 동일 | 0 | 같은 로그 |
| reset 연결 보호 | apps/web cwd `pnpm -w db:seed --reset` | `task579-check.ts:58` | 기존 연결이 있으면 exit1·DB 보존 / 의도된 거부 | 1 (기대값) | [거부 원문](task579/attempt1/apps-web-cwd-reset-refusal.log) |
| reset·seed 실제 수용 | 연결 종료 후 같은 명령 | `task579-check.ts` migration count assert | 0000~0013 총14 migration+seed / 동일 | 0 | [시드](task579/apps-web-cwd-reset-seed.log) |
| 금지 SSE·공개 키 | 실 HTTP 공식 `chat_hacking` | `task579-http.ts:16`, `:47` | token0·금지 내부 키10개 각각0·공개 schema 통과 / 동일 | 단위 pass, 해당 시도 전체1 | [부분 실행 JSON](task579/attempt2/results.json) |
| 해킹 클릭 전환 | 실 HTTP 동시 convert | `task579-http.ts:47` | HTTP201/200·같은 ticket·ticket1·worker job0 / 동일 | 단위 pass, 해당 시도 전체1 | 같은 JSON |
| 승인 자동 전환 | 실 HTTP approvalMode=true | `task579-http.ts:69` | token0·done.ticketId·중복전환200·ticket1·job0·같은 draft 출처 유지 / 동일 | 단위 pass, 해당 시도 전체1 | 같은 JSON |
| system 메타데이터 | 실제 GET 대화 복원 | 위 두 전환 assert | hacking forbidden_category/ESCALATED, approval approval_mode/APPROVAL_REQUIRED / 동일 | 단위 pass | 같은 JSON |
| 실제 heartbeat | 실제 KB cache revision 증가+검증 DB만 테이블 잠금 | `task579-http.ts:84` | `: keep-alive` 주석 15046ms 수신, 파서는 주석 제외 / 기본15000ms | 0 | [최종 HTTP 명령](task579-command-3.log), [JSON](task579/attempt3/results.json) |
| agents 감사 원자성 | 검증 DB만 audit INSERT 실패 trigger | `task579-http.ts:130` | HTTP500 후 active/세션폐기0/audit0 / 전체 rollback | 0 | 같은 최종 로그·JSON |
| agents 폐기·격리·권한 | 실제 HTTP+PG | `task579-http.ts:130` | disabled200/이전 세션401/audit1/타tenant404/자기·비agent·agent생성403 / 동일 | 0 | 같은 최종 로그·JSON |
| agents 배정·목록 | 실제 HTTP+PG | `task579-http.ts:125`, `:130` | 비활성 새배정400, 기존할당수1·disabled 보존 / 동일 | 0 | 같은 최종 로그·JSON |
| 비밀번호 비노출 | 실제 audit/list 결과 검사 | `task579-http.ts:130` | audit/list에 임시 비밀번호0 / 동일 | 0 | 같은 JSON. 서버 stdout 정확 문자열 대조0은 이후 matrix 실행에서 확인(아래 최신 상태 참조) |
| cwd·env·바인딩 | apps/web cwd root dev | `task579-check.ts` runtime identity assert | port3200, root/worker DB명 동일·AI_MODE=mock·POLL=500 / 동일 | 0 | [서버](task579/apps-web-cwd-root-dev.log) |
| 정리 | 소유 COMMENT/연결 수 확인 | `task579-check.ts` finally | 연결0·소유 DB만 DROP / 동일 | 0 | 같은 최종 JSON |
| 마지막 web 타입 | `node node_modules/typescript/bin/tsc -p apps/web/tsconfig.json --noEmit --incremental false` | TypeScript 진단 | 진단0 / 동일 | 0 | 도구 실행 원문 |

## 시도별 차이와 경계

- 첫 HTTP 명령은 convert에 필수 title을 검증 코드가 누락해 400/400으로 실패했다. 공식 demo.title을 사용하도록 고쳤고 앱 소스는 바꾸지 않았다. [첫 원문](task579-command.log).
- 다음 시도는 전환까지 통과했으나 warmed KB cache 때문에 테이블 잠금이 실제 조회에 걸리지 않아 heartbeat 전에 완료됐다. 이 시도 전체 exit1을 유지한다. [두 번째 원문](task579-command-2.log).
- 캐시 revision을 검증 DB 안에서 증가시켜 실제 loader를 대기시킨 뒤, 이미 통과한 전환·reset 거부는 반복하지 않고 heartbeat·agents 잔여만 실행했다. [세 번째 원문](task579-command-3.log)은 최종 exit0이다.
- 테스트 audit 실패의 HTTP500·SQL 오류 stack은 의도된 원자성 검사이며 정의 경고가 아니다. 정의 경고 원인은 여전히 미확정이다. 운영 build0은 이전 창1 근거로 유지하며 이번에 반복하지 않았다.
- abort 두 경계는 [별도 실제 HTTP DB 로그](abort-command.log)를 재사용한다. 해당 실행 전 route source의 `result.aiResult` 저장을 확인했으며 API 필터 테스트 시작 시각은 2026-10-22 08:02:23 KST다. 메모리 req.signal 전파와 실제 HTTP DB 결과는 동일 증거로 취급하지 않는다.
- Windows 실제 종료는 소유 taskkill tree 정리이며 OS SIGTERM 전달 pass가 아니다. 핸들러 주입 검사와 실제 종료는 이전 로그에서 분리돼 있다.

## 최신 창1 상태(TASK584)

16행 실제 수집 exit0/부장 수동16of16 판정 승인, 실제 stdout 임시 비밀번호 검출0 및 소유 PID/listener/DB active0을 확인했다. 원본은 task579/demo-matrix.json과 task579-matrix-command.log이며 재수집하지 않았다. probe는 ticket(probe@0.85, worker job)이다. 수동 판정 후 창4 같은 JSON judge-16 기계 대조는 아직 미완료다.

현재 수정 harness로 SSE 전체 한 실행 exit0을 별도 확보했다. 이전 attempt2 전체1/부분 성공은 그대로 보존하며 혼합하지 않는다. [TASK584 항목별 표·실제 done/source 예시·종료 근거](task584-sse-report.md)를 참조한다. 최종 web tsc exit0이다.

창1 종료 후 창2·3 Next/공유 쓰기 중지. 창4 최종 install/lock·README 통합·최종 판정은 별도 공지 대기다. static-paths는 기존 운영 build 미재현/원인 미확정으로 구분한다.
