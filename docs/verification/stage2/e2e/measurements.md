# E2E 실측 3가지 (TASK#588, 동결 최종 실행)

- 근거 파일: 이 폴더의 `webserver.log`(최종 실행), `check-after-playwright.txt`, `report.json`, `gates.txt`
- 최종 실행: 2026-10-22 09:04~09:10(KST), Playwright 375.4s, 61건 모두 통과
- 1차 실행 자료는 `run1/`에 따로 있다.

## ① 인자 전달

webServer 명령(cwd `apps/web`, Windows `cmd.exe`):

```
(pnpm -w db:seed --reset && pnpm -w dev --port 3200 --hostname 127.0.0.1) > "<repo>/docs/verification/stage2/e2e/webserver.log" 2>&1
```

| 확인 대상 | webserver.log 줄 | 내용 |
| --- | --- | --- |
| reset 인자 → 루트 스크립트 | 3 | `$ pnpm --filter @support/db seed "--reset"` |
| reset 인자 → seed 실행 | 6 | `$ tsx src/seed.ts "--reset"` |
| reset 실제 수행 | 12 | `Recreated validated local _e2e database` |
| migrate | 13~26 | `Applied 0000_initial.sql` … `Applied 0013_ai_runs_source_contract.sql` (14개) |
| seed | 27 | `AI dataset seed complete; …` |
| dev 인자 → 루트 dev.mjs | 30 | `$ node scripts/dev.mjs "--port" "3200" "--hostname" "127.0.0.1"` |
| worker 기동 | 39, 42, 49 | `$ node scripts/worker.mjs`, `worker.runtime {"pid":8024,"parentPid":29232,"database":"support_desk_e2e","aiMode":"mock","pollIntervalMs":"500"}`, `$ tsx src/worker-entry.ts` |
| dev 인자 → next | 40 | `$ next dev "--port" "3200" "--hostname" "127.0.0.1"` |
| 바인딩 | 57, 58 | `- Local: http://127.0.0.1:3200`, `- Network: http://127.0.0.1:3200` |
| 준비 | 64 | `✓ Ready in 2.1s` |

정리하면 다음과 같다.
- `--reset`, `--port 3200`, `--hostname 127.0.0.1`이 하위 스크립트까지 그대로 전달됐다.
- worker도 webServer env(`DATABASE_URL`=support_desk_e2e, `AI_MODE=mock`, `WORKER_POLL_INTERVAL_MS=500`)를 상속했다.

## ② Windows 트리 종료

Playwright 종료 직후 점검 결과(`check-after-playwright.txt`, 2026-10-22T09:10:21+09:00):

| 항목 | 결과 |
| --- | --- |
| 3200 리스너 | 0 |
| node 프로세스(dev.mjs·next·worker) | 0 |
| support_desk_e2e 연결(pg_stat_activity) | 0 |
| worker PID 8024 / 부모 PID 29232 | 둘 다 없음 |

- Playwright의 webServer 종료만으로 cmd → pnpm → dev.mjs → next·worker 트리가 모두 정리됐다. 따로 정리한 PID는 없다.
- webserver.log 끝에 worker의 종료 로그는 없다. 정상 종료가 아니라 트리 강제 종료로 판단한다. 남은 프로세스·리스너·DB 연결이 없다는 점만 확인한 것이다.
- 1차 실행(run1) 뒤에도 이어서 실행한 spec 재확인이 3200 충돌 없이 시작됐다.

## ③ 재컴파일 횟수

`webserver.log`의 `Compiled` 줄은 **21줄**이다.

- **파일 변경으로 인한 재컴파일(HMR, 라우트 없는 `✓ Compiled in …`)은 0줄**이다. Playwright 결과물을 `%TEMP%`에 두고 리포트를 `docs/`에 쓰는 구성이라, next dev 감시를 건드리지 않았다.
- 라우트별 첫 컴파일은 15줄이다(라우트 15개).
- 이미 컴파일된 라우트를 다시 컴파일한 줄은 6줄이다. 모듈 수가 줄어든 상태로 다시 컴파일된 것으로 보아, dev의 비활성 페이지 정리(on-demand entries) 뒤 재진입으로 판단한다. 파일 변경 때문은 아니다.

| 라우트 | 첫 컴파일 | 재컴파일 |
| --- | --- | --- |
| `/api/[...path]` | 1317ms | – |
| `/t/[slug]` | 2.2s | 1111ms |
| `/t/[slug]/login` | 780ms | – |
| `/t/[slug]/signup` | 958ms | 1241ms |
| `/platform/login` | 466ms | – |
| `/t/[slug]/tickets` | 444ms | – |
| `/t/[slug]/tickets/new` | 497ms | – |
| `/t/[slug]/tickets/[id]` | 787ms | – |
| `/t/[slug]/admin` | 562ms | – |
| `/t/[slug]/admin/settings` | 873ms | 616ms |
| `/t/[slug]/admin/kb` | 655ms | 584ms |
| `/t/[slug]/admin/tickets/[id]` | 963ms | – |
| `/platform` | 773ms | 1043ms |
| `/t/[slug]/admin/agents` | 1152ms | – |
| `/t/[slug]/admin/metrics` | 905ms | 704ms |

- setup 워밍업(`warm up dev routes`)은 44.2s가 걸렸다. setup 프로젝트 전체는 46.2s다.
- 워밍업 대상이 아닌 `/t/[slug]/admin/agents`, `/t/[slug]/admin/metrics`는 테스트 중에 처음 컴파일됐다. 둘 다 약 1s였고 타임아웃은 없었다.
- 서버 오류 줄(`⨯`, `Unhandled`, `ERR_`)은 0줄이다.
