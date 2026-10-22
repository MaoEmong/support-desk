# support_desk 전진 migration 계획 (승인 전 — 실행하지 않음)

작성: TASK597, 2026-10-22. 상태: **보류**(부장 범위 결정 대기). 이 문서는 계획과 복제본 리허설 결과만 담는다.

## 현재 상태

- 대상: `localhost:55432/support_desk`(docker `support-desk-postgres-1`). ※ `localhost:5432`는 다른 프로젝트 DB이므로 대상 아님.
- `support_migrations`: `0000`~`0005`까지만 적용(1단계 schema). 현재 코드는 `0013`까지 전제 → 계정과 무관하게 `/api/t/:slug/settings/public`부터 500.
- 데모 계정 9개 전환은 완료(`convert-support_desk.log`). 행: tenants 2, tenant_settings 2, users 9, kb_articles 2, 티켓·대화·AI 실행 0, 세션 0.

## 적용 절차(승인 후)

1. 이 DB에 붙은 앱 프로세스 없음 확인: `select count(*) from pg_stat_activity where datname='support_desk'` = 0
2. 백업(전체, custom 형식):
   `docker exec support-desk-postgres-1 pg_dump -U support -d support_desk -Fc -f /tmp/support_desk_pre0006.dump`
   `docker cp support-desk-postgres-1:/tmp/support_desk_pre0006.dump docs/verification/demo-accounts/backup/`
   (복원 리허설: `createdb support_desk_restorecheck` → `pg_restore -d support_desk_restorecheck …` → 아래 before 질의와 동일한지 확인 → 삭제)
3. before 스냅샷: `migration-rehearsal/before.txt`와 같은 질의(마이그레이션 목록, 행 수, users id·tenant·email·role·password_hash md5, KB id·slug·본문 md5, 설정값)
4. `DATABASE_URL=postgresql://support:***@localhost:55432/support_desk pnpm db:migrate`(전진만, 한 트랜잭션·advisory lock, reset 없음)
5. after 스냅샷 → 대조(아래 기대값과 다르면 중단하고 백업에서 복원)

## 기대 변환(복제본 리허설로 확인한 값)

리허설: `support_desk` 복제본 `support_desk_demoacct_premig`에 동일 절차 → `migration-rehearsal/before.txt`, `after.txt`, `migrate.log`(exit 0, 0006~0013 적용).

| 항목 | 변화 |
| --- | --- |
| 행 수(tenants·settings·users·tickets·messages·KB·대화·AI 실행·세션) | 동일 |
| users id·tenant·email·role·password_hash | 동일(데모 계정 전환 결과 유지) |
| KB id·slug·제목·본문 | 동일. `question` 추가(0006 backfill: 제목), `revision`=1 |
| ai_threshold | 0.85 → 0.85(0011: float4 → double, 소수 4자리 정규화. 현재 값은 변화 없음) |
| primary_color | 동일(#7c3aed / #2563eb, 0012는 NULL일 때만 보완) |
| approval_mode·forbidden_categories·allowed_link_domains·chatbot_name·ai_system_prompt | 동일 |
| categories | `["general","account","billing","bug"]` → 같은 id의 객체 + 금지 id(refund·account_theft·sanction)와 `other` 추가(총 8개). label은 id 그대로(관리자 화면에서 수정 필요) |
| 새 컬럼 | fallback_category=`other`, auto_answer_limit=1, kb_revision=0 |

주의: 리허설 설정의 categories label이 id(영문) 그대로라 화면 표시가 어색하다. 데이터 보존 원칙상 migration·seed는 기존 관리자 설정을 덮지 않으므로, 필요하면 관리자 설정 화면에서 수정한다.

## 되돌리기

전진 migration은 자동 down이 없다. 문제 시 앱 중지 → `support_desk`를 새 이름으로 보존 → 백업 dump를 `support_desk`로 `pg_restore`.
