# TASK584 창1 SSE 전체 실행 근거

현재 harness 한 실행에서 exit **0**. 이전 attempt2 부분 성공을 합산하지 않았다. 기준선·이전 중간 결과·창4 최종 검증을 구분한다.

실제 명령: 루트에서 `pnpm --config.verify-deps-before-run=false --filter @support/db exec tsx test/sse-complete-check.ts`. 명령 출력은 [원문](task584-sse-complete-command.log), 실제 값은 [JSON](task584/results.json), 서버 출력은 [root dev](task584/root-dev.log)에 보존했다.

| 항목 | 명령 | assert 파일:줄 | actual / expected | exit | log |
|---|---|---|---|---|---|
| 금지 문의·공개 키 | 위 전체 명령 | task579-http.ts:31,47 | token0; confidence/urgency/sentiment/summary/score/tenantId/reasonDetail/decision/usage/pipelineVersion 각각0; 공개 schema 통과 / 동일 | 0 | task584/results.json |
| 해킹 클릭 전환 | 같은 실행 | task579-http.ts:47 | 동시 요청200/201, ticket1, worker job0; forbidden_category/ESCALATED / 동일 | 0 | 같은 JSON |
| 승인 자동 전환 | 같은 실행 | task579-http.ts:69 | token0, done.ticketId=중복전환 ticketId, ticket1, job0, draft conversation 유지; approval_mode/APPROVAL_REQUIRED / 동일 | 0 | 같은 JSON |
| heartbeat | 같은 실행 | task579-http.ts:88,89 | 실제 `: keep-alive` 15038ms, 파서 주석 제외 / 기본15000ms | 0 | 같은 JSON |
| staff 공개 근거 | 같은 실행 | task579-http.ts:101,102,103 | public agent 메시지 sources 3개, strict 공개 SourceSchema 통과 / 내부 키 없음 | 0 | 같은 JSON |
| abort 커밋 전 | 같은 실행 | sse-complete-abort.ts:25 | customer1/assistant0/run0/draft0 / 동일 | 0 | 같은 JSON |
| abort 커밋 후 | 같은 실행 | sse-complete-abort.ts:39 | customer1/assistant1/run1/draft0 보존, 추가 assistant0, 후속200 / 동일 | 0 | 같은 JSON |
| 전체 실행·정리 | 같은 실행 | sse-complete-check.ts:50,53,56,61 | priorPassesUsed=false; PID0/listener0/DB active0, 소유 DB만 DROP / 동일 | 0 | 같은 JSON |
| 최종 web 타입 | `node node_modules/typescript/bin/tsc -p apps/web/tsconfig.json --noEmit --incremental false` | TypeScript 진단 | 진단0 / 동일 | 0 | 도구 원문(출력 없음) |

assert 경로는 모두 `packages/db/test/` 아래다. heartbeat 대기는 소유 검증 DB의 KB revision 증가 및 테이블 잠금으로 만들었다. abort는 검증 DB trigger/advisory lock을 사용하며 production 우회 환경변수는 추가하지 않았다.

## done.data 실제 예시

승인 자동 전환:
```json
{"conversationId":"12a8c6de-ab31-4737-ae3c-9a3baaf6b66a","messageId":"00098474-0a51-4717-bdb4-0b1e6264eda2","ticketId":"fab519ce-b72c-4e60-a696-69f08b66a966"}
```

해킹 클릭 전환 전 SSE done:
```json
{"conversationId":"efa50c74-0319-452a-9a89-cc8285ed1abb","messageId":"ea2f72fc-6f43-4bfb-a986-014b666c0b24"}
```
이 done에는 ticketId가 **없다**. 이후 클릭 convert 응답 ticketId는 `865259a6-7661-4952-8d8b-d291dc55a1c6`이다. 미래 클릭 결과를 이전 SSE에 소급해 넣지 않는다.

## staff 공개 sources 예시

public agent 메시지 `e6866784-7d9f-4418-aad8-8e928b589983`의 첫 근거:
```json
{"id":"21aaac6a-5ece-5b2d-9efa-790127876de6","title":"PC 최소·권장 사양","excerpt":"최소 사양은 64비트 운영체제, 4코어 프로세서, 메모리 8GB, 그래픽 메모리 2GB입니다. 권장 사양은 6코어 프로세서, 메모리 16GB, 그래픽 메모리 6GB이며 저장 공간은 40GB를 확보해 주세요. 설치 전에 운영체제와 그래픽 드라이버를 최신 상태로 확인해 주세요. 도움말"}
```

## 기존 성공 근거 재사용과 종료

- apps/web cwd `pnpm -w db:seed --reset`: 활성 연결 시 거부 exit1 및 DB 보존, 연결 해제 후 정상 exit0은 [기존 reset 로그](task579-command.log)에 보존했다. 재실행하지 않았다.
- apps/web cwd `pnpm -w dev --port 3200 --hostname 127.0.0.1`: root/worker가 같은 DB·AI_MODE=mock·WORKER_POLL_INTERVAL_MS=500을 상속하고 실제 신규 job을 처리한 기존 증거는 [matrix 명령](task579-matrix-command.log)과 [matrix 실행 JSON](task579/results.json)에 있다. 이번에도 같은 cwd/명령으로 실행했다.
- 16행은 [기존 JSON](task579/demo-matrix.json)을 재수집하지 않았다. 부장 수동16/16 승인 완료. **수동 판정 후 창4 같은 JSON judge-16 기계 대조**는 미완료다. probe는 **ticket(probe@0.85, worker job)** 이다.
- 임시 비밀번호 실제 stdout 정확 문자열 검출0과 matrix 종료 점검은 기존 matrix 증거를 재사용한다.
- 이번 소유 DB `support_sse584_1792625629047_e2e`: COMMENT 소유 확인 후 active0에서 DROP. 공유 `support_desk_e2e` 무접촉. 소유 PID survivors=[], listener=[] 확인.
- Windows 소유 tree 정리 후 자식 exit1은 종료 수단의 결과이며 전체 driver exit0과 구분한다. 실제 OS SIGTERM 핸들러 전달은 미검증이다.
- static-paths/definition 경고는 **기존 운영 build에서 미재현, 원인 미확정**이다. 기존 운영 build0을 보존하며 이번 전체 build는 실행하지 않았다.

창1 증거 수집 종료. 창2·3에서는 Next 실행과 공유 쓰기를 중지한다. 최종 install/lock/README 통합·기계 대조는 창4 별도 공지를 기다린다.
