# TASK597 데모 계정 간소화 — 검증 근거 (2026-10-22)

이전 근거(`docs/verification/*`, `docs/http-acceptance-results.json` 등)는 덮어쓰지 않았다. 이 폴더만 새로 만들었다.

| 파일 | 내용 | 결과 |
| --- | --- | --- |
| `typecheck.log` | contracts·db·web tsc | 0 / 0(role 타입 수정 후 재실행) / 0 |
| `lint.log` | 변경 파일 eslint | exit 0 |
| `db-test.log` | `packages/db/test/demo-accounts.test.ts`(소유 DB `support_desk_demoacct_test`) | 11/11 pass |
| `convert-support_desk.log` | 실제 `support_desk` dry-run → `--apply` → 재실행 | exit 0. 전환 9, 재실행 이미 전환 9, 폐기 세션 0(원래 0), 행 수·id 보존 |
| `migrate-clone.log`, `http.log`/`http.json` | 전환된 support_desk 복제본(0006~0013 migrate) + 임시 Next 3300 HTTP | migrate exit 0, HTTP 49/49 |
| `migration-rehearsal/` | 원본 상태 복제본으로 migration 전후 대조 리허설 | counts·users·KB 동일, settings는 categories만 변환 |
| `support_desk-migration-plan.md` | 실제 migration 전 백업·대조 계획 | 승인 후 적용 |
| `support_desk-apply.log` | 실제 `support_desk`: 백업 → migrate → 대조 → seed 1회 → 대조 | 백업·migrate·seed exit 0 |
| `support_desk-before.txt`, `support_desk-after-migrate.txt`, `support_desk-after-seed.txt`, `snapshot.sql` | 전후 스냅샷(비밀번호는 해시 md5, 본문 md5) | |
| `http-support_desk.log`/`.json` | 실제 support_desk + 임시 Next 3300(새 문의 생성 없음) | 52/52 |
| `next-dev*.log` | 임시 Next 로그 | `definition` 경고 없음 |
| `server-pids.log` | 임시 서버 PID·종료·listener·DB 연결·소유 DB 삭제 | listener 0, 소유 PID 0, support* 연결 0 |

백업: `%USERPROFILE%\support-desk-backups\support_desk_pre0006_20261022-131359.dump`(공유 트리 밖, 52,338 bytes, `pg_restore -l` 확인).
