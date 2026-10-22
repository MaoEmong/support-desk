# apps/web 서버 (인증·API)

모든 `/api/*` 요청은 `src/app/api/[...path]/route.ts`(runtime `nodejs`) → `server/runtime.ts`의 `getApp()` → `server/app.ts` 하나로 들어온다.
가드(`tenant-guard.ts`) → 역할 정책(`policy.ts`) → 라우트(`routes/*`) → 저장소(`repo/*`) 순서이며, 오류 본문은 항상 `{ code, message, details }`이다.

## 구조

| 파일 | 역할 |
| --- | --- |
| `tenant-guard.ts` | `/t/{slug}` → 테넌트 해석(없음·정지 404), 변경 요청 Origin 검사, 세션 조회·만료, 세션 소속 ≠ 경로 테넌트면 401, CSRF 헤더 검사 |
| `policy.ts` | 역할 매트릭스 단일 모듈. 다른 고객/테넌트 리소스는 404, 역할 부족 403. 상담원 상태 전이표 |
| `auth/*` | bcryptjs 해시, 세션(쿠키 토큰 → `sessions.id = sha256`), 유휴(`lastSeenAt`)+절대(`expiresAt`, 연장 없음) 만료, 로그아웃 `revokedAt`, 로그인 제한(계정 키·IP 키, `login_attempts`) |
| `dto.ts` | 고객 DTO / 상담원 DTO를 별도 화이트리스트 함수로 구성. 고객 응답은 public 메시지만 먼저 거른 뒤 만든다 |
| `repo/types.ts` | 저장소 계약. 테넌트 리소스 메서드는 모두 `tenantId`를 받는다 |
| `repo/drizzle.ts` | PostgreSQL 구현(`@support/db`의 `db`). `tx()` = `db.transaction`, `lockTicket` = `SELECT … FOR UPDATE`, 조건부 UPDATE(version/status) |
| `repo/memory.ts` | 테스트용 구현(같은 계약, tx는 뮤텍스+스냅샷 롤백) |
| `ai/queue.ts` | 생산자 인터페이스. Postgres에서는 `tx.enqueueJob` → `@support/queue`의 `enqueueInquiry(tx, …)`를 **같은 트랜잭션 executor**로 호출 |
| `ai/chat.ts` | 챗봇 응답기. 운영은 `@support/ai` `streamInquiry(input, deps, {signal})`, 테스트·미연동은 스텁(항상 이관) |
| `ai/sse-public.ts` | 내부 AI 이벤트 → 공개 `{event,data}` 화이트리스트 변환 + token 게이트(정책 판단 전·이관 후·승인 모드 차단) |
| `ai/deps.ts` | web·worker 공용 파이프라인 deps: 문의 리더(tenant 범위), 설정 리더(캐시 없음, `parseTenantSettingsRow`), 공개 KB 캐시(`createCachedKbRepository` + `tenant_settings.kb_revision`) |
| `ai/queue-adapter.ts` | 워커 전용: 실제 `processInquiry` → 큐 결과(`maskDeep` 원본 보관, 재생성 메시지 해석, 일시/영구 실패 구분) |
| `ai/worker-bootstrap.ts` | `@support/queue` worker-entry가 `WORKER_BOOTSTRAP_MODULE`로 불러오는 Node-safe 조립: `createWorkerDependencies(): {db, processInquiry, close}` |

## 세션·CSRF 규약 (프론트)

- 쿠키: 테넌트 `sd_session`(HttpOnly) + `sd_csrf`(JS 읽기 가능), 플랫폼 `sd_psession` + `sd_pcsrf`. SameSite=Lax, 운영 Secure.
- GET 외 모든 인증 요청은 `X-CSRF-Token: <sd_csrf 값>` 헤더 필수(없거나 틀리면 403 `CSRF_FAILED`). 로그인/가입/me 응답 본문에도 `csrfToken`이 있다.
- 인증 전 변경 요청(로그인·가입)은 `Content-Type: application/json`만 허용(아니면 415), 다른 Origin이면 403.
- 401 `UNAUTHENTICATED`(미로그인·다른 테넌트 세션) / 401 `SESSION_EXPIRED`(만료·폐기) → 로그인 화면. 429 `TOO_MANY_ATTEMPTS`는 `Retry-After` 헤더.

## 엔드포인트 (`/api` 접두사 생략)

`docs/api-contract.md` 표에 **없는(추가) 항목은 ★**, 계약 표와 **다른 항목은 △**.

| method | 경로 | 권한 | 비고 |
| --- | --- | --- | --- |
| GET | /t/:slug/settings/public | 공개 | 브랜딩·챗봇 이름·approvalMode·aiMode |
| POST | /t/:slug/auth/signup | 공개 | `{email,password(8+),name}` → 고객으로만 가입, 201 + 세션 |
| POST | /t/:slug/auth/login | 공개 | 계약 `LoginInput`(tenantSlug는 무시, 테넌트는 경로로만) |
| POST | /t/:slug/auth/logout | 로그인 | 204 |
| GET | /t/:slug/auth/me | 로그인 | `{user, tenant, csrfToken}` |
| GET | /t/:slug/tickets | customer | 본인 것만, `?page&pageSize(≤50)` |
| POST | /t/:slug/tickets | customer | 계약 `CreateTicketInput {title, body, conversationId?}`. ★`Idempotency-Key` 헤더(재시도 중복 방지). conversationId가 있으면 대화 전환과 같은 경로 |
| GET | /t/:slug/tickets/:id | customer | 남의 것 404 |
| POST | /t/:slug/tickets/:id/messages | customer | 재문의. resolved → open 복귀, closed 409. 자동답변 받은 티켓은 AI 재실행 없이 이관 |
| POST | /t/:slug/tickets/:id/resolve | customer | 해결 확인(멱등) |
| GET | /t/:slug/admin/tickets | agent·tenant_admin | `?status&category&urgency&sentiment&assigneeId(me|none|id)&escalated&page&pageSize` |
| GET | /t/:slug/admin/tickets/:id | agent·tenant_admin | messages(internal 포함)·drafts·aiRuns |
| ★PATCH | /t/:slug/admin/tickets/:id | agent·tenant_admin | 계약 `UpdateTicketInput {version,status?,assigneeId?}`. version 불일치 409 `VERSION_CONFLICT`, 전이 불가 409 `INVALID_TRANSITION` |
| ★POST | /t/:slug/admin/tickets/:id/messages | agent·tenant_admin | 계약 `StaffMessageInput {body, visibility}` |
| POST | /t/:slug/admin/tickets/:id/replies | agent·tenant_admin | 공개 답변(위의 별칭) |
| POST | /t/:slug/admin/tickets/:id/notes | agent·tenant_admin | 내부 메모(위의 별칭) |
| POST | /t/:slug/admin/tickets/:id/drafts/:draftId/approve | agent·tenant_admin | 계약 `ApproveDraftInput {version, body?}` → 발송. 409 시 `details.current`에 최신 초안 |
| ★PATCH | /t/:slug/admin/tickets/:id/drafts/:draftId | agent·tenant_admin | 초안 수정 `{version, body}` |
| ★POST | /t/:slug/admin/tickets/:id/drafts/:draftId/reject | agent·tenant_admin | `{version, reason?}` |
| ★POST | /t/:slug/admin/tickets/:id/drafts/regenerate | agent·tenant_admin | 202 `{jobId}`. 진행 중 재생성 작업 있으면 409 `JOB_IN_PROGRESS` |
| GET | /t/:slug/admin/agents | agent·tenant_admin | `{items:[{id,name,email,role,status,assignedOpenCount}]}`(열린 티켓 담당 수) |
| ★POST | /t/:slug/admin/agents | tenant_admin | `{name,email}` → 201 `{agent:{id,name,email,role,status}, temporaryPassword}`. role=agent·tenant 서버 고정, 임시 비밀번호는 이 응답에서만(해시만 저장, 감사·로그 미기록). 중복 409 `EMAIL_TAKEN` |
| ★PATCH | /t/:slug/admin/agents/:id | tenant_admin | `{status:'disabled'}`만(재활성화 범위 밖). 상태+세션 전부 폐기+감사 한 트랜잭션. 자기 자신·비agent 403, 다른 테넌트 404. 비활성 상담원은 새 배정 불가 |
| GET | /t/:slug/admin/metrics | agent·tenant_admin | KPI: autoResolutionRate·escalationRate·categoryDistribution + aiMode |
| ★GET / PATCH | /t/:slug/admin/settings | tenant_admin | 브랜딩·AI 설정(aiThreshold 0~1, forbiddenCategories, approvalMode, allowedLinkDomains…) |
| ★GET / POST | /t/:slug/admin/kb | 조회 agent·tenant_admin / 생성 tenant_admin | `{title, body, category?, tags?, published?}` |
| ★GET / PATCH / DELETE | /t/:slug/admin/kb/:id | 조회 agent·tenant_admin / 변경 tenant_admin | |
| ★POST | /t/:slug/chat | customer | 계약 `ChatInput {conversationId?, body}` → SSE. 없으면 새 대화 |
| ★GET | /t/:slug/conversations/:id | customer | 본인 대화 + 메시지 |
| ★POST | /t/:slug/conversations/:id/convert | customer | 계약 `ConvertConversationInput {title}`. 처음 201, 이후·동시 요청 200(같은 ticketId) |
| POST | /platform/auth/login · logout, GET /platform/auth/me | platform_admin | 별도 쿠키 영역 |
| ★GET | /platform/tenants | platform_admin | 테넌트 목록 + 집계만(본문 없음) |
| ★GET | /platform/metrics | platform_admin | 전체 집계 |

### SSE (`POST /t/:slug/chat`)

직렬화는 contracts `formatPublicSSE`(공개 `SSEEventSchema` 검증 포함)만 쓴다. AI 내부 이벤트·AI `formatSSE`는 고객에게 보내지 않는다.
- 자동답변: `classified {category, conversationId}` → `sources {sources:[{id,title,excerpt?,url?}]}` → `token {token}`* → `done {conversationId, messageId}`
- 이관·승인 모드: `classified` → `escalated {reason: DecisionReason, message}` → `done {conversationId, messageId, ticketId?}`(승인 모드는 같은 tx에서 티켓 자동 전환, 멱등)
- 실패: `error {code: AI_UNAVAILABLE, message}` → `done`
- 15초 heartbeat 주석(`: keep-alive`), `x-accel-buffering: no`. 연결이 끊기면 abort를 파이프라인까지 전파하고 **고객 질문 외에는 아무것도 저장하지 않는다**(부분 답변·결과·초안 없음).
- 내부 `done.result`는 저장 후 축소: `ai_runs`(jobId 없음, 결과 `maskDeep`), 자동답변이 아니면 초안을 대화당 1개(`ai_drafts.conversation_id` UNIQUE)로 보존 → 전환 시 같은 행에 `ticket_id`만 추가(출처 유지, 재생성 없음).
- 고객 대화 복원: system 안내에만 `escalationReason`(DecisionReason)과 `noticeCode`(APPROVAL_REQUIRED·ESCALATED·PROCESSING_FAILED). 값이 없으면 키 생략.
- 대화에서 전환된 티켓은 `ai_jobs`를 만들지 않는다(워커 재처리 없음). `escalatedAt`·`escalationReason` 기록, status는 open.

### 응답 DTO 차이(계약 대비 추가 필드)

- 고객 티켓: `customerStatus(received|answered|in_progress|resolved|closed)`, `resolvedAt`, `closedAt`, 상세에 `canConfirmResolved`, `canComment`. 메시지에 `authorType`, `authorName`, `sources[{id,title,url?,excerpt}]`.
- 상담원 티켓: `customer/assignee{id,name,email}`, `category/urgency/sentiment`, `escalated`, `autoAnsweredAt`, `resolvedByCustomer`, `closedAt`. 메시지에 `authorType`, `authorName`, `sources`, `draftId`. 초안·aiRuns에 개별 분석 필드.
- 목록 응답: `{items, page, pageSize, total}`.

## 동시성·원자성

- 문의(티켓+첫 메시지)와 `ai_jobs`는 한 트랜잭션. 큐 등록 실패 시 문의도 롤백. 키: `ticket:{ticketId}:message:{messageId}:{pipelineVersion}`.
- 공개 상담원 답변·초안 승인·PATCH·재생성은 트랜잭션에서 `tickets` 행 `FOR UPDATE` 후 처리 → 워커 자동답변과 직렬화(늦은 AI 발송 차단은 워커가 같은 잠금 후 상담원 공개답변·autoReplyCount 검사).
- 초안 승인은 `ai_drafts`의 `version`·`status in (draft, approved)` 조건부 UPDATE에 성공한 요청만 메시지를 넣는다(나머지 409). 승인 메시지: `role=<승인자 역할>`, `authorType=agent`, `draftId`, `sourceJobId=draft.jobId`.
  `@support/queue`의 `approveDraft()`와 같은 의미(행 잠금 → 조건부 갱신 → 메시지 → 티켓 version+1)이며, 감사 기록·`decidedBy`·`sentMessageId`·편집 본문을 같은 트랜잭션에 넣기 위해 저장소 메서드로 구현했다.
- 대화 전환: `conversations.status` open→converted 조건부 UPDATE + `tickets.conversation_id UNIQUE`.

## 테스트

- `__tests__/*.test.ts`: 메모리 저장소로 HTTP 경로 전체(가드·정책·DTO)를 검증. 세션·CSRF·로그인 제한·격리(IDOR, 교차 테넌트)·DTO 비노출·409·전환 중복·플랫폼 집계 전용.
- `__tests__/postgres.integration.test.ts`: `TEST_DATABASE_URL`(마이그레이션된 일회용 DB)이 있을 때만 실행. 실제 트랜잭션·행 잠금·조건부 UPDATE·롤백 확인. 없으면 skip — **메모리 테스트 통과는 DB 증거가 아니다.**

- `__tests__/ai-contract.integration.test.ts`: `@support/ai/testing` 적합성 키트(KB 8 + Settings 5)를 DB 구현으로 실행 + web·worker 별도 KB 캐시가 `kb_revision`으로 함께 갱신되는지, KB 롤백 시 revision 불변.

## 공개 근거(sources)

`public-sources.ts`의 `toPublicSources(raw, {tenantId, allowedLinkDomains})` 한 곳: 다른 테넌트 항목 제외 → 공용 순수 projection(`@support/queue` `projectPublicSources`) → url은 https + 허용 도메인일 때만.
고객 공개 메시지(`ticket_messages`·`conversation_messages`)는 저장부터 `{id,title,excerpt?,url?}`, 모든 응답 DTO·SSE `sources` 이벤트도 같은 함수를 다시 거친다(이전 `kbArticleId` 행도 id로 읽음). AI 원본 근거(점수·tenantId)는 `ai_runs`·`ai_drafts`에만.

## 설정 PATCH

입력은 공유 `TenantSettingsPatchSchema`(strict) 그대로 + 서버 규칙(logoUrl https/상대 경로). `version`·`autoAnswerLimit`은 400, 동시 수정은 last-write-wins(감사 기록). 카테고리 id 불변은 `assertCategoryIdsUnchanged`.

## SSE 끊김 경계

done 저장 트랜잭션 **커밋 전** 끊김 → 롤백(고객 질문만 남음). **커밋 후** 끊김 → 저장 유지(삭제하지 않음), 같은 대화는 계속 사용 가능.

## KB 캐시 무효화

KB 생성·수정(비공개 전환 포함)·삭제는 같은 트랜잭션에서 `tenant_settings.kb_revision`을 +1한다. web·worker 캐시는 검색마다 revision을 확인해 바뀌면 다시 읽고(프로세스 간), 같은 프로세스는 커밋 직후 `invalidate`, TTL은 안전망.

## 남은 일

- 고객 목록 표시 상태 계산 N+1(페이지 ≤50) 개선.
- IP 기준 로그인 제한은 `x-forwarded-for`의 첫 값을 클라이언트 IP로 쓴다. **운영 서버는 반드시 신뢰 프록시(로드밸런서·리버스 프록시) 뒤에 두고, 그 프록시가 사용자가 보낸 `X-Forwarded-For`를 버리고 실제 접속 IP로 덮어쓰도록 설정해야 한다.** 그렇지 않으면 클라이언트가 헤더를 위조해 IP 제한을 우회할 수 있다. 이 경우에도 계정 단위(테넌트+이메일) 로그인 제한은 헤더와 무관하게 그대로 적용된다.
