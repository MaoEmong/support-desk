# API·DB 공유 계약

## STAGE2 TASK553 선계약 초안

이 절이 아래 STAGE1 기록보다 우선합니다. 전체 검증·프론트 실행은 팀장 조정 후 진행합니다. `@support/contracts/ai`는 AI 패키지의 순수 계약만 re-export하며 provider/data/Node 모듈을 포함하지 않습니다. `DecisionReasonSchema`, `DECISION_REASONS`가 판단 사유의 단일 원천입니다.

### 설정·DB 컬럼

- `tenantSettings`: tenantId, displayName, logoUrl?, primaryColor?, chatbotName, aiSystemPrompt, aiThreshold, forbiddenCategories:string[], approvalMode, categories:CategoryDef[], allowedLinkDomains:string[], **autoAnswerLimit**, **fallbackCategory**, **kbRevision**, version, updatedAt. `?`는 SQL nullable입니다.
- CategoryDef는 `{ id, label, keywords, description? }`. AI `CategoryDefSchema`로 검증하며 별도 카테고리 ID 규칙을 만들지 않습니다.
- `autoAnswerLimit`은 기본 1, CHECK = 1로 고정합니다. `fallbackCategory`는 SQL 기본값 없이 AI settings.json의 유효 id를 seed에 명시합니다. `forbiddenCategories`의 기본값은 []이며 기존 관리자 정책은 유지합니다.
- `kbArticles`는 **question:text default''**으로 원본 질문을 보존합니다. tenantSettings.kbRevision은 캐시 무효화용 단조 증가값이며 kbArticles.revision은 API 수정의 버전 비교용으로 보존합니다. source의 question을 answer/body와 분리해 보존합니다.
- `conversationMessages`는 **reason:text nullable**, **noticeCode:text nullable**을 추가합니다. noticeCode는 `APPROVAL_REQUIRED | ESCALATED | PROCESSING_FAILED`입니다. DB reason은 공개 DTO의 선택 키 escalationReason으로 매핑하고 공유 DecisionReason으로 검증합니다. `0007_conversation_notices.sql`에 반영했습니다.
- 나머지 테이블·컬럼은 아래 14개 테이블 계약을 유지합니다. tenant 복합 FK, sourceJobId unique, aiJobs/aiRuns의 ticket/conversation XOR는 유지합니다.

`0006_stage2_settings_kb.sql`과 `0007_conversation_notices.sql`을 추가합니다. 기존 migration은 수정하지 않습니다. 기존 categories string[]를 객체[]로 변환하면서 object 원소는 보존합니다. 기존 금지 카테고리와 fallback에 해당하는 정의가 빠져 있으면 카테고리 객체만 보충하며 정책값은 덮어쓰지 않습니다. aiSystemPrompt/chatbotName 정식 컬럼을 재사용하고 별칭 컬럼을 추가하지 않습니다.

### 공개·staff DTO

공개 설정 categories는 길이를 하드코딩하지 않은 `{id,label}[]`이고 admin은 CategoryDef 전체입니다. 공개 설정은 allowedLinkDomains를 포함하며 aiSystemPrompt 등 내부 정책 프롬프트는 포함하지 않습니다. staff 티켓에 statusLabel/categoryLabel/urgencyLabel/sentimentLabel을 포함합니다. 카테고리 라벨은 해당 tenant의 categories에서 매핑합니다. staff aiRuns.reason은 공유 DecisionReason 또는 null, confidence는 0~1 number 또는 null입니다.

공개 source는 `{id,title,excerpt?,url?}`입니다. url은 제공될 경우 URL 문자열이며 nullable이 아닙니다. AI 내부 source의 tenantId/score를 그대로 공개 DTO로 보내지 않습니다.

### 공개 SSE

이벤트는 `{event,data}`이며 wire는 `event: <event>\ndata: <JSON(data)>\n\n`입니다. 정상 순서는 `classified → sources → token* → escalated? → done`입니다. 오류는 error 뒤 done으로 닫습니다. 중간 실패도 추가 token 없이 error/done으로 종료합니다.

- classified: category, conversationId (내부 분석·confidence 비노출)
- sources: sources 배열. 근거가 없더라도 빈 배열 이벤트를 먼저 보냅니다.
- token: token 문자열
- escalated: **reason: DecisionReason**, **message: 고객 안내문**, ticketId?
- done: **conversationId**, messageId?, ticketId?만 허용. AIRunResult/analysis/result를 포함하지 않습니다.
- error: 기존 API 오류 DTO

`SSESequenceSchema`로 순서를 검사합니다. AI 자체 SSE 타입은 내부 처리 계약이며 공개 SSE에 그대로 직렬화하지 않습니다. system 메시지는 escalationReason?과 noticeCode?를 공개할 수 있고 user/assistant 메시지에는 이 안내 메타데이터를 넣지 않습니다.

### 상담원 관리

- POST `/api/t/:slug/admin/agents`: `{name,email}`, 성공 201. `{agent:{id,name,email,role,status},temporaryPassword}`를 최초 응답 한 번에만 제공합니다. 재조회·로그에 임시 비밀번호를 넣지 않습니다. 중복 EMAIL_TAKEN은 409입니다.
- PATCH `/api/t/:slug/admin/agents/:id`: `{status:'disabled'}`. 소속과 tenant_admin 권한을 서버에서 검증합니다.
- GET `/api/t/:slug/admin/agents`: status, assignedOpenCount 포함. assignedOpenCount는 해당 상담원에게 배정된 open/in_progress 티켓 수입니다.

### KPI

동일 tenant·기간 **생성 티켓**을 분모로 사용합니다. autoResolvedTickets는 그 집합에서 AI 답변 이후 고객이 해결 확인한 티켓 수, escalatedTickets는 이관된 고유 티켓 수입니다. 자동해결률과 이관률은 0~1 비율입니다. 카테고리 분포도 메시지·run 수가 아닌 티켓당 1회 집계하며 미분류는 fallbackCategory로 묶습니다. 기간은 UTC `[from,to)`입니다.

### 시드·worker 경계

설정·KB는 `@support/ai/data`의 loadSeedBundle을 단일 원천으로 사용합니다. demo는 같은 모듈의 loadDemoBundle/loadDemoSet/getDemoCase 및 실제 `data/demo/{slug}.json`만 사용합니다. **channel=chat 사례를 티켓으로 시드하지 않습니다.** ticket 사례는 demo.message/title/settingsOverride로 MockProvider 파이프라인을 실행하고 기대 decision/reason/category/confidence와 대조한 결과로 티켓·작업·run·공개 답변 또는 초안을 시드합니다. 별도 하드코딩된 문장·답변·기대값을 만들지 않습니다. 시드 자체는 Claude 모드에서도 외부 모델을 호출하지 않습니다.

demo UUID 및 idempotencyKey는 slug/key 기반으로 안정적입니다. 기존 demo 티켓이 있으면 다시 쓰지 않습니다. DB 정식 필드 매핑만 수행하고 기존 설정행·비밀번호·KB 편집은 onConflictDoNothing으로 보존합니다. demo의 settingsOverride는 해당 실행 스냅샷에만 적용하며 실제 관리자 설정을 바꾸지 않습니다. 두 테넌트 fallbackCategory는 other입니다.

`pnpm dev`는 root `scripts/dev.mjs`에서 web과 독립 worker를 함께 실행합니다. `pnpm worker`는 `scripts/worker.mjs`에서 `WORKER_BOOTSTRAP_MODULE` 기본값을 `apps/web/src/server/ai/worker-bootstrap.ts`의 절대 file URL로 설정한 뒤 `pnpm --filter @support/queue worker`를 실행합니다. 큐 스크립트는 `tsx src/worker-entry.ts`, API 소유 Node-safe bootstrap은 `createWorkerDependencies(){db,processInquiry,close?}`를 제공합니다. bootstrap 자체가 두 번째 worker를 시작하면 안 됩니다.

poll 변수는 `WORKER_POLL_INTERVAL_MS`이며 기본 1000ms, E2E는 500ms입니다. web 또는 worker 종료/실패는 sibling 종료로 전파하고 root 종료도 소유한 자식 프로세스 트리에만 전파합니다. `pnpm dev:web`은 web만 실행하는 명시적 진단 명령입니다. bootstrap 파일은 API팀 소유이며 해당 파일의 구현 준비 여부는 런타임 검증과 별도로 기록합니다.

`pnpm db:seed -- --reset`은 localhost PostgreSQL의 정확한 `<identifier>_e2e` DB만 재생성하고 migrate/seed합니다. query/fragment로 대상 DB·host를 덮어쓰는 URL과 일반 개발 DB reset은 거부합니다. 대상에 활성 연결이 있으면 거부하며 기존 연결을 종료하거나 DROP FORCE를 사용하지 않습니다.

이 문서는 확정 SQL과 공유 Zod 계약의 기준입니다. URL 목록은 API팀 라우트 구현과 통합 시 대조합니다. 리소스 식별자는 UUID, JSON 날짜는 ISO 8601 UTC 문자열입니다. TS 필드는 camelCase, SQL 컬럼은 snake_case입니다.

## 권한 및 오류

tenant slug로 경계를 해석하고 인증된 세션 tenantId와 일치시킵니다. 고객은 본인 문의만, agent/tenant_admin은 같은 테넌트 문의만 볼 수 있습니다. 플랫폼 관리자는 문의 본문·AI 원문을 조회할 수 없습니다. 요청 본문의 tenantId/customerId/role을 신뢰하지 않습니다.

오류 본문은 `{ code, message, details }`입니다. 401은 미인증·만료, 403은 역할·CSRF 검증 실패, 404는 타인·타테넌트 자원을 포함한 존재 숨김, 409는 버전·상태 충돌, 429는 로그인 시도 제한입니다. 세부 code는 `ErrorCodeSchema`를 따릅니다. 쿠키는 HttpOnly, 운영 환경 Secure이며 쓰기 요청에는 Origin/CSRF 검증을 적용합니다.

## 공유 export

`@support/db`는 `db`, `client`, `pool`, `schema`, `Database` 및 아래 테이블을 export합니다. 일반 엔티티의 `id`는 UUID(default random)이며, **sessions.id는 토큰 SHA256 해시를 담는 text PK**입니다. 날짜는 `Date`로 읽습니다. 테넌트 설정은 tenantId가 PK입니다.

| export | 주요 필드 |
| --- | --- |
| tenants | id, slug(unique), name, status(active/suspended), createdAt, updatedAt |
| tenantSettings | tenantId, displayName, logoUrl, primaryColor, chatbotName, aiSystemPrompt, approvalMode, aiThreshold(double precision), forbiddenCategories:string[], categories:string[], allowedLinkDomains:string[], version, updatedAt |
| users | id, tenantId(nullable), email, name, passwordHash, role, status(active/disabled), isActive, createdAt, updatedAt |
| sessions | id(text PK=SHA256 token hash), userId, tenantId(nullable), role, csrfToken, lastSeenAt, revokedAt, ip, userAgent, expiresAt, createdAt |
| loginAttempts | id, tenantId(nullable), email, ipHash, key, succeeded, ip, createdAt |
| tickets | id, tenantId, customerId, title, body, status, version, autoReplyCount, autoAnsweredAt, category, urgency, sentiment, idempotencyKey, resolvedByCustomer, closedAt, escalatedAt, escalationReason, assigneeId, conversationId(unique nullable), resolvedAt, customerConfirmedAt, createdAt, updatedAt |
| ticketMessages | id, tenantId, ticketId, authorId(nullable), role(customer/agent/tenant_admin/ai), authorType(customer/agent/ai/system nullable), sources, draftId, body, visibility(public/internal), sourceJobId(unique nullable), createdAt |
| conversations | id, tenantId, customerId, status(open/converted/closed), ticketId(nullable), createdAt, updatedAt |
| conversationMessages | id, tenantId, conversationId, role(user/assistant/system), body, sources(jsonb nullable), sourceJobId(unique nullable), createdAt |
| aiJobs | id, tenantId, ticketId(nullable), conversationId(nullable), messageId, kind, pipelineVersion(default v1), idempotencyKey, status, attempts(default 0), maxAttempts(default 3), availableAt, leaseUntil, leaseToken, lastError, createdAt, updatedAt |
| aiRuns | id, tenantId, ticketId(nullable), conversationId(nullable), jobId(unique), status, result(jsonb nullable), messageId, decision, reason, category, urgency, sentiment, confidence, sources, model, inputTokens, outputTokens, latencyMs, error, pipelineVersion, createdAt, updatedAt |
| aiDrafts | id, tenantId, ticketId, jobId(unique), runId, sources, decidedBy, decidedAt, rejectReason, sentMessageId, body, status, version(default 1), createdAt, updatedAt |
| kbArticles | id, tenantId, slug, title, body, category(nullable), tags, published, sourceUrl(nullable), createdAt, updatedAt |
| auditLog | id(uuid PK), tenantId(uuid nullable), actorId(uuid nullable), action(text), targetType(text), targetId(text nullable), meta(jsonb nullable), createdAt |

Platform user만 tenantId=null이 가능하며 이메일은 테넌트별 대소문자 무관 unique입니다. 플랫폼 이메일도 별도 unique입니다. 세션 토큰 원문은 저장하지 않습니다. auditLog의 null 테넌트는 플랫폼 작업을 의미합니다. audit 기록 actor의 권한·소속은 서비스가 검증합니다.

## 상태와 원자성

- TicketStatus: `open | in_progress | resolved | closed`. 고객 표시: 접수됨 / 처리 중 / 답변 완료 / 종료됨. resolved에서 고객 재문의는 open으로 복귀합니다.
- AIRunStatus: `queued | processing | succeeded | failed`. 분석·모델·근거·confidence·토큰·소요시간·오류는 result JSON에 저장합니다.
- AIDraftStatus: `draft | approved | sent | rejected`. 승인·편집은 version을 비교하고 불일치 시 409입니다.

aiJobs는 ticketId/conversationId 중 정확히 하나를 가져야 합니다. messageId는 nullable이지만 kind=process_inquiry일 때는 CHECK 제약으로 필수입니다. 값이 있으면 같은 테넌트·같은 부모 메시지를 가리키는지 커밋 시 지연 트리거로 검사합니다. 고객 메시지 생성과 enqueue는 같은 트랜잭션에서 실행합니다. `(tenantId,idempotencyKey)` unique이며 키는 대상·messageId·pipelineVersion으로 결정합니다.

`sourceJobId` unique와 jobId unique는 중복 메시지/실행/초안을 방지합니다. worker는 leaseToken과 leaseUntil을 확인해야 하며 완료·답변 생성·autoReplyCount 증가는 한 트랜잭션이어야 합니다. 늦은 AI 발송은 티켓 버전·상태와 autoReplyCount를 다시 검증해 차단합니다. 자동답변은 티켓당 최대 1회입니다. conversationId unique로 대화→문의 중복 변환을 막습니다.

## 요청·응답 Zod

현재 API팀 라우터에서 확인한 상대 경로는 아래와 같습니다. Next 진입점의 `/api` prefix를 붙인 실제 HTTP 경로로 수용검증했습니다.

| method | 상대 경로 | 목적 |
| --- | --- | --- |
| GET | /t/:slug/settings/public | 공개 테넌트 설정 |
| POST | /t/:slug/auth/signup | 고객 가입 |
| POST | /t/:slug/auth/login | 테넌트 로그인 |
| POST | /t/:slug/auth/logout | 로그아웃 |
| GET | /t/:slug/auth/me | 현재 사용자 |
| GET / POST | /t/:slug/tickets | 본인 문의 목록 / 생성 |
| GET | /t/:slug/tickets/:id | 본인 문의 상세 |
| POST | /t/:slug/tickets/:id/messages | 재문의 |
| POST | /t/:slug/tickets/:id/resolve | 고객 해결 확인 |
| GET | /t/:slug/admin/tickets | 상담원 문의 목록 |
| GET | /t/:slug/admin/tickets/:id | 상담원 상세 |
| POST | /t/:slug/admin/tickets/:id/replies | 공개 답변 |
| POST | /t/:slug/admin/tickets/:id/notes | 내부 메모 |
| POST | /t/:slug/admin/tickets/:id/drafts/:draftId/approve | 초안 승인 |
| GET | /t/:slug/admin/agents | 배정 가능한 상담원 |
| GET | /t/:slug/admin/metrics | 테넌트 집계 |
| POST | /platform/auth/login | 플랫폼 로그인 |
| POST | /platform/auth/logout | 플랫폼 로그아웃 |
| GET | /platform/auth/me | 플랫폼 사용자 |

API팀은 현재 별도 validation/DTO를 작성 중입니다. 문의 제목은 최종 합의에 따라 DB·공유 계약 모두 `title`입니다. 상세 메시지 표현 등 나머지 DTO 차이는 통합에서 대조해야 합니다.

`@support/contracts`의 `LoginInputSchema`, `CreateTicketInputSchema`, `CreateMessageInputSchema`, `StaffMessageInputSchema`, `UpdateTicketInputSchema`, `ApproveDraftInputSchema`, `ChatInputSchema`, `ConvertConversationInputSchema`, `PaginationSchema`를 사용합니다. 문의 생성은 `{ title, body, conversationId? }`, 초안 승인은 `{ version, body? }`입니다.

고객 목록/상세는 `CustomerTicketSchema` / `CustomerTicketDetailSchema`이며 메시지는 `CustomerMessageSchema`를 사용합니다. API는 public 메시지만 먼저 필터링한 뒤 DTO를 구성해야 합니다. Zod 필드 제거만으로 내부 메시지 행을 숨길 수는 없습니다. customer DTO에는 tenantId, 내부 메모, 미승인 초안, AI 분석을 넣지 않습니다.

상담원 응답은 `StaffTicketSchema` / `StaffTicketDetailSchema`이며 visibility·drafts·aiRuns를 포함할 수 있습니다. 이 DTO를 고객 endpoint에 재사용하지 않습니다. DB는 최종 합집합에 따라 role과 authorType을 함께 보관하며, 서버 내부 runAfter는 repository에서 availableAt으로 매핑합니다.

## 최종 합집합 변경

`0001_union_contract.sql`은 초기 SQL 위에 최종 합의를 적용합니다. 설정 이름은 `aiThreshold`(SQL `ai_threshold`)와 `allowedLinkDomains`(SQL `allowed_link_domains`)입니다. sessions.id는 토큰 SHA256 해시를 담는 text PK이고 별도 tokenHash는 없습니다. 이전 세션이 존재하면 전진 마이그레이션에서 폐기 처리합니다.

`packages/db/src/schema.ts`는 각 테이블의 select 타입(`Tenant`, `TenantSettings`, `User`, `Session`, `LoginAttempt`, `Ticket`, `TicketMessage`, `Conversation`, `ConversationMessage`, `AiJob`, `AiRun`, `AiDraft`, `KbArticle`, `AuditEntry`)과 대응하는 `New*` insert 타입을 export합니다. `pool`은 실제 `pg.Pool` 인스턴스이고 `client`는 동일 Pool의 호환 별칭입니다. `db`는 `drizzle-orm/node-postgres` 어댑터를 사용합니다. 마이그레이션은 연결을 획득하여 트랜잭션 종료 후 release하고, 마이그레이션·시드 프로세스는 finally에서 pool.end()를 호출합니다. 순환 참조 테이블의 일부 복합 외래키는 SQL 마이그레이션에서 추가합니다.

계약 패키지는 순수 Zod·타입만 export하며 DB·Node 모듈을 import하지 않습니다. 실제 pg.Pool 및 node-postgres 어댑터로 전체 타입 점검을 통과했고, 마이그레이션·시드·PostgreSQL 통합 8개 및 DB 제약 점검을 실행했습니다. 최신 전체 테스트·lint·빌드 결과는 README의 검증 상태를 참고하세요.

## SSE

`Content-Type: text/event-stream`, 캐시 금지. `SSEEventSchema`는 `{ event, data }` 형식이며 wire는 `event: <event>\ndata: <JSON(data)>\n\n`입니다.

| event | data |
| --- | --- |
| classified | category, conversationId |
| token | token |
| sources | sources:[{id,title,url?}] |
| escalated | reason, ticketId? |
| done | conversationId, messageId?, ticketId? |
| error | code, message, details? |

분류·정책 결정을 먼저 완료하고 자동답변이 허용될 때만 token을 전송합니다. 승인 모드는 초안을 노출하지 않고 상담원 확인 안내와 티켓 전환을 제공합니다. 게시판은 3~5초 폴링을 사용합니다.

## AI 경계

`processInquiry({tenantId,ticketId|conversationId,messageId})`는 AI 소유 패키지의 결과 타입을 반환합니다. AI는 DB에 직접 쓰지 않습니다. `@support/contracts/ai`는 실제 `@support/ai/contracts`의 순수 계약을 re-export합니다. 루트 contracts도 AIRunResult 등 주요 타입을 제공하며, 충돌하는 이름은 AISourceSchema/AISSEEventSchema로 제공합니다. 내부 분석과 고객용 SSE source는 서로 다른 계약이며 변환은 서버에서 수행합니다.



### STAGE2 SSE 영속성 보강 (0008)

- tenantSettings.kbRevision / tenant_settings.kb_revision: integer NOT NULL DEFAULT 0, 0 이상. KB 생성·수정·삭제와 같은 트랜잭션에서 증가시키고 web/worker는 매 처리마다 읽습니다. revision은 관리자 PATCH 입력이 아닙니다.
- aiRuns.jobId / ai_runs.job_id: nullable UNIQUE. ticketId/conversationId 정확히 하나를 유지합니다. job 없는 SSE run은 messageId 필수이며 tenantId + 대상 ID + messageId + pipelineVersion 부분 UNIQUE로 멱등성을 보장합니다.
- aiDrafts.jobId: nullable UNIQUE, runId는 기존 tenant 복합 FK 유지. ticketId/conversationId는 각각 nullable이며 출처 제약은 jobId/conversationId 정확히 하나입니다. conversationId는 UNIQUE입니다. job 없는 draft는 runId 필수입니다.
- 대화 전환은 기존 draft 행의 ticketId를 추가하고 conversationId를 그대로 유지하는 UPDATE입니다. draft id/runId/본문을 승계하며 재생성으로 대체하지 않습니다. 실제 전환 트랜잭션 구현은 API 소유입니다.
- conversationMessages.reason/noticeCode는 0007의 nullable text이며 공개 SSE는 기존 {event,data}, source excerpt?, system escalationReason?/noticeCode?, done IDs 전용 계약을 유지합니다.
- 0008은 소스 구현 완료이며 DB 적용/제약 실행검증은 아직 미실행입니다.

0009_final_settings_policy.sql은 autoAnswerLimit=1, fallback SQL 기본값 제거 및 유효 id 검증, 정책을 전진 보완합니다. kb_articles.revision은 최신 API 계약에 따라 보존합니다. 알 수 없는 테넌트의 잘못된 fallback은 임의 선택하지 않고 명시 오류로 중단합니다. 기존 유효 관리자 선택은 보존합니다. DB 적용은 독립 DB 검증으로 완료했습니다(backend-verification.md의 실행별 범위 참조).

0010_draft_source_contract.sql 최종제약: ai_drafts_source CHECK ((job_id IS NOT NULL)::int + (conversation_id IS NOT NULL)::int = 1), ai_drafts_conversation_unique UNIQUE(conversation_id), job_id UNIQUE 유지. ticketId/conversationId XOR는 제거합니다. SSE 전환 후 둘 다 설정될 수 있으며 같은 draft/run/body와 conversation 출처를 유지합니다. 공개 포맷 함수는 `import { formatPublicSSE } from "@support/contracts"`이며 실제 구현 경로는 packages/contracts/src/index.ts입니다. 내부 AI formatSSE와 구분합니다.

### Threshold 저장 정밀도 정책 (0011)

aiThreshold / ai_threshold는 double precision입니다. 0011은 `USING round(ai_threshold::numeric,4)::double precision`으로 기존 float4 값을 소수 4자리로 명시 정규화합니다. 이는 기존 값 변경 정책이며 비트 단위 보존이 아닙니다. 읽기 매퍼의 임의 반올림이나 테스트 기대 완화는 하지 않습니다. aiRuns.confidence는 기존 double precision을 유지하며 이 정규화 정책을 적용하지 않습니다. 원본 result.confidence.final과의 DB 비교가 기준입니다.

### Branding·공개 DTO 확정 및 실검증

- 새 demo 설정은 pixelforge primaryColor=#7c3aed, mailpulse=#2563eb입니다. 0012는 기존 NULL만 보완하며 관리자 지정 색상은 보존합니다. 재시드도 기존 설정을 덮지 않습니다.
- system 메시지 공개 키는 `escalationReason?: DecisionReason`, `noticeCode?: APPROVAL_REQUIRED | ESCALATED | PROCESSING_FAILED`입니다. DB 컬럼 reason/notice_code는 유지합니다. user/assistant에는 두 키를 생략하며 공개 reason 키는 사용하지 않습니다.
- settings PATCH는 last write wins이며 version과 autoAnswerLimit 입력을 모두 strict 거부합니다. 조회의 autoAnswerLimit=1은 유지합니다.
- 공개 메시지 seed sources는 id 식별자/제목/excerpt?/허용 URL만 저장하고 내부 tenantId·점수·분석을 제외합니다. 원본 AI 분석은 ai_runs/ai_drafts에 유지합니다. 공개 DTO는 sources {id,title,excerpt?,url?} 허용 목록을 재적용합니다.

### 창1 settings PATCH 확정 입력

PATCH `/api/t/:slug/admin/settings`는 strict 허용 목록 displayName, logoUrl, primaryColor, chatbotName, aiSystemPrompt, aiThreshold, forbiddenCategories, approvalMode, categories, allowedLinkDomains, fallbackCategory만 받습니다. 모든 키는 선택이며 version/autoAnswerLimit/kbRevision 등 나머지 키는 거부합니다. settings에 신규 version 필수나 낙관잠금409 요건을 추가하지 않습니다. 동시 편집은 마지막 저장이 적용되고 감사 로그를 유지합니다. 티켓·초안의 기존 version409 계약은 별개입니다.

### SSE 취소의 커밋 경계 (부장 최종)

- 커밋 전 취소: customer/user 질문만 보존하고 응답 저장 트랜잭션은 rollback합니다. assistant·ai_runs·ai_drafts는 0건입니다.
- 커밋 후 취소: 이미 확정된 메시지·run·draft를 삭제하지 않으며 추가 중복을 만들지 않습니다. open 대화의 같은 conversationId로 후속 요청은 정상 처리하며 취소 사실만으로 409를 만들지 않습니다.
- 공개 done은 저장 tx commit 이후에 전송됩니다. 고객에게 보낸 token 조각 자체가 커밋 증거는 아닙니다.
- 실제 HTTP 검증은 독립DB 안의 테스트 전용 INSERT advisory gate로 커밋 전 취소를 고정했고, 커밋 후 취소는 done 관찰 뒤 취소했습니다. production 권한·환경변수·테스트 endpoint는 추가하지 않았습니다.
