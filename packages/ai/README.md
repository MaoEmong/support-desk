# @support/ai — AI 자동화 파이프라인

멀티테넌트 헬프데스크의 AI 처리 패키지. 고객 문의 하나를 받아 **분류 → 테넌트 KB 검색 → 정책 판단 → 답변 생성**을 수행하고, 결과(`AIRunResult`)를 돌려준다.
DB 에는 쓰지 않는다. 저장·큐·권한은 백엔드가 맡고, 이 패키지는 주입받은 인터페이스로만 데이터를 읽는다.

```
문의 ─▶ 인젝션·링크 검사 ─▶ 분류(LLM/mock) ─▶ KB 검색(tenantId 필수) ─▶ tenantId 재검증
     ─▶ 확신도 결합(LLM·검색·규칙) ─▶ 정책 ─▶ 생성 ─▶ sanitize·출력 안전 검사 ─▶ AIRunResult
```

## 실행

```bash
# 워크스페이스 루트에서 설치했다면 그대로 사용
pnpm --filter @support/ai typecheck
pnpm --filter @support/ai test
pnpm --filter @support/ai eval

# 이 패키지만 단독으로 설치·실행 (루트 파일을 건드리지 않음)
cd packages/ai
pnpm install --ignore-workspace --config.strict-dep-builds=false
pnpm typecheck && pnpm test && pnpm eval
```

> pnpm 11 은 의존성 빌드 스크립트(esbuild)를 승인하지 않으면 설치를 실패로 끝낸다. 단독 설치에서는 `--config.strict-dep-builds=false` 를 붙인다(esbuild 는 플랫폼 바이너리 패키지로 동작하므로 빌드 스크립트 없이도 문제없다). 워크스페이스 설치는 루트 `pnpm-workspace.yaml` 의 `allowBuilds` 가 처리한다.

### 환경변수

| 변수 | 값 | 설명 |
|---|---|---|
| `AI_MODE` | `mock` \| `claude` | **필수.** 조용히 mock 으로 바꾸지 않는다. 비어 있으면 설정 오류 |
| `ANTHROPIC_API_KEY` | | `AI_MODE=claude` 일 때 필수. 없으면 `AIConfigError` |
| `AI_MODEL` | 기본 `claude-opus-5-5` | Claude 모델 교체 |
| `AI_TIMEOUT_MS` | 기본 `60000` | 요청 타임아웃 |
| `AI_MAX_RETRIES` | 기본 `2` | SDK 재시도(429·5xx·네트워크) |

## AI 모드

**기본값은 `AI_MODE=mock` 이다.** 앱의 `.env.example`·dev·E2E·시연은 모두 mock 으로 돈다. 이 패키지 자체는 값을 추측하지 않으므로, `AI_MODE` 가 비어 있으면 설정 오류를 낸다(조용히 mock 으로 바뀌는 일이 없다).

### mock (기본)

- 테넌트 설정의 카테고리 **키워드**로 분류하고, 근거 문서 본문을 템플릿에 넣어 답한다. 같은 입력에는 항상 같은 결과가 나온다(가짜 스트리밍 포함). 관리자 화면에는 mock 배지를 띄운다.
- **한계**
  - 키워드 기반이라 표현이 조금만 달라져도 분류·확신도가 바뀐다. 오타·줄임말·돌려 말하기에 약하다.
  - 결과가 보장되는 것은 **`data/demo` 의 고정 시연 문장뿐**이다. 평가 셋 수치도 키워드 사전을 평가 셋에 맞춰 조정한 결과라 실제 분류 품질을 뜻하지 않는다.
  - 문장을 새로 짓지 않는다. 답변은 KB 본문 그대로이며, 긴급도·감정은 업종 무관 휴리스틱이다.
  - 그래서 시연·개발·E2E 용이며, 답변 품질 평가는 claude 모드로 해야 한다.

### claude

- 공식 SDK `@anthropic-ai/sdk` 를 쓴다. `ANTHROPIC_API_KEY` 가 있을 때만 켠다.
  - 분류는 `messages.parse` + `zodOutputFormat` 으로 구조화 출력을 받는다. 카테고리는 테넌트 enum 으로 제한하고 effort 는 `low` 다.
  - 생성은 `messages.create` / `messages.stream` 으로 하고 effort 는 `medium` 이다.
  - 모델이 거부하면(`stop_reason=refusal`) 상담원에게 이관한다.
  - 챗봇 연결이 끊기면(`signal`) HTTP 스트림을 abort 한다.
- **미검증:** 이 저장소에서는 API 키 없이 개발했기 때문에 claude 모드의 실호출은 한 번도 검증하지 않았다. 타입 검사와 mock 경로 테스트만 통과한 상태다. 운영 전에 `pnpm eval --mode claude` 로 안전 기준과 시연 문장 결과를 확인해야 한다(실제 API 비용 발생, 시연 문장의 기대 확신도는 mock 기준이라 claude 에서는 참고용).

## 연동 인터페이스 (백엔드)

```ts
import { processInquiry, streamInquiry, createProvider, loadAIConfig, formatSSE } from '@support/ai';

const deps = {
  provider: createProvider(loadAIConfig()),          // AI_MODE 로 선택
  kb: myKbRepository,                                // search({ tenantId, query, limit, preferCategory })
  settings: { getTenantAISettings: (tenantId) => … },// TenantAISettings | null
  inquiries: { getInquiryContext: (input) => … },    // { message: {id, body}, autoAnswerCount } | null (tenant 범위 안에서만)
};

// 게시판(작업 큐): 항상 AIRunResult 를 반환한다. 오류도 result.error 에 담고 decision=escalate 로 둔다.
const result = await processInquiry({ tenantId, ticketId, messageId }, deps);

// 챗봇(SSE): 내부 이벤트를 받아 서버가 공개 DTO 로 바꿔 내보낸다. 연결이 끊기면 signal 로 취소한다.
for await (const ev of streamInquiry({ tenantId, conversationId, messageId }, deps, { signal: req.signal })) {
  if (ev.type === 'done') await save(ev.result);   // done 을 받았을 때만 저장
  else res.write(toPublicSSE(ev));                  // tenantId·score·내부 result 는 고객에게 보내지 않는다
}
```

- **취소(`{ signal }`)**: abort 되면 provider 호출을 취소하고, 이후 token 을 내지 않으며, `error`·`done` 없이 generator 가 끝난다. 부분 답변은 저장하지 않는다. `for await` 를 `break` 해도 provider 스트림은 닫힌다. 세 번째 인자를 생략하면 기존 동작과 같다.

### KB 저장소: `createCachedKbRepository`

```ts
import { createCachedKbRepository } from '@support/ai';

const kb = createCachedKbRepository(
  (tenantId) => loadPublishedArticles(tenantId),               // 반드시 tenant 조건 + published 만
  { getRevision: async (tenantId) => (await readSettings(tenantId))?.kbRevision ?? null, ttlMs: 300_000 },
);
kb.invalidate(tenantId); // 같은 프로세스에서 KB 를 고친 직후(선택)
```

- 테넌트별 문서를 한 번 읽어 BM25 인메모리 인덱스로 검색한다. Postgres 전문검색은 한국어 형태소 지원이 약해 쓰지 않는다.
- web·worker 는 별도 프로세스이므로 **`getRevision` 이 프로세스 간 무효화 기준**이다. KB 를 바꾸는 트랜잭션에서 `kbRevision` 을 올린다. `invalidate` 는 같은 프로세스 안의 즉시 비우기, `ttlMs` 는 안전망이다.
- loader 결과와 검색 결과 모두 tenantId 를 재검증한다. 다른 테넌트 문서가 섞이면 `TenantMismatchError` 를 내고 캐시하지 않는다.
- 동시에 들어온 첫 검색은 로드를 한 번만 하고, `invalidate` 이전에 시작된 로드 결과는 버린다.

### 어댑터 적합성 키트: `@support/ai/testing`

백엔드의 DB 구현이 계약을 지키는지 확인하는 검사 목록이다. 테스트 프레임워크에 묶이지 않는다.

```ts
import { kbRepositoryContract, settingsReaderContract } from '@support/ai/testing';

const tenantIds = { a: tenantA.id, b: tenantB.id, unknown: randomUUID() };
describe('KB 적합성', () => {
  for (const c of kbRepositoryContract({ tenantIds, setup: async (fx) => { await insertKb(fx); return dbKb } })) it(c.name, c.run);
});
describe('설정 적합성', () => {
  const checks = settingsReaderContract({ tenantIds, setup: async (fx) => { await upsertSettings(fx); return reader }, updateThreshold });
  for (const c of checks) it(c.name, c.run);
});
```

- KB(8): 테넌트별 결과 격리, 다른 테넌트 전용 문서 비노출(`preferCategory` 포함), 비게시 문서 제외, 알 수 없는 테넌트 `[]`, 빈 tenantId 거부, `limit`, `KbHit` 형식.
- Settings(5): 두 테넌트 설정의 무손실 왕복(`categories` jsonb 포함), 알 수 없는 테넌트 `null`, 빈 tenantId, **임계값 변경이 캐시 없이 즉시 반영**(마지막에 실행되며 테넌트 A 의 임계값을 바꾼다).
- 실제 DB 권한·동시성 테스트를 대체하지 않는다.

### 결정 사유 목록

`DECISION_REASONS`(11개, `as const`)는 `DecisionReasonSchema` 의 원본이다. 화면 라벨 매핑이나 DB 검증에 쓴다.

- `tenantId` 는 서버가 세션으로 검증한 값을 넘긴다. KB 저장소는 해당 테넌트 문서만 돌려줘야 한다. 파이프라인은 반환된 문서의 `tenantId` 를 다시 검사하고, 다른 테넌트 문서가 하나라도 섞이면 실행을 거부한다(`error.code=TENANT_MISMATCH`, 근거 0건, 이관).
- `autoAnswerCount` 에는 해당 티켓·대화에서 이미 고객에게 나간 AI 자동답변 수를 넣는다. 한도(`autoAnswerLimit`, 기본 1)를 넘으면 이관한다.
- `result.error.code` 가 `PROVIDER_ERROR` 이면 재시도할 수 있다. 재시도해도 실패하면 결과를 그대로 저장하면 된다(이미 이관 결정 상태).
- `draft.customerVisible === true` 는 `decision=auto_answer` 일 때뿐이다. 그 밖의 초안은 상담원만 본다. 고객 DTO 에서 빼야 한다.
- 운영 로그에 메시지 원문을 남겨야 하면 `maskPII` / `maskDeep` 을 거친다.

### 결과 (`AIRunResult`)

| 필드 | 설명 |
|---|---|
| `decision` | `auto_answer` \| `escalate` \| `pending_approval` |
| `reason` | `confident_kb_match`, `approval_mode`, `forbidden_category`, `injection_suspected`, `suspicious_link`, `low_confidence`, `no_sources`, `auto_answer_limit`, `unsafe_output`, `provider_refusal`, `ai_error` |
| `classification` | `category`, `urgency`(low~critical), `sentiment`(positive~angry), `confidence`, `summary` |
| `confidence` | `final`(결합값, 임계값과 비교), `llm`, `retrieval`, `rule` |
| `sources[]` | `kbArticleId`, `title`, `excerpt`, `tenantId`, `score` — 답변 근거 표시용 |
| `draft` | sanitize 된 마크다운 `body`, `sources`, `model`, `customerVisible` |
| `usage[]`, `timing` | 토큰·소요시간(ai_runs 저장용) |
| `flags` | 인젝션 의심, 문의 속 허용 밖 링크, 출력에서 제거한 링크 |

### 챗봇 SSE 이벤트

```
classified → (escalated → done)                 # 이관·승인 대기: token 없음
classified → sources → token* → done            # 자동답변
classified → sources → token* → escalated → done  # 생성 중 안전 검사 위반(위반 문장은 나가지 않음)
… → error → done                                # 오류
```

- 분류와 정책 판단을 **먼저** 끝낸다. 자동답변이 허용된 경우에만 생성 스트림을 연다. 그래서 금지 카테고리 답변이 고객 화면에 흘러나갈 수 없다.
- `token.text` 는 문장 단위로 버퍼링한 뒤 sanitize 와 출력 안전 검사를 통과한 조각만 담는다. 문자 단위 스트림이 아니다.
- 와이어 포맷은 `formatSSE(ev)` → `event: <type>\ndata: <json>\n\n` 이다.

## 정책

판단 순서가 곧 우선순위다.

1. 금지 카테고리: LLM 분류 결과가 금지 카테고리이거나, **금지 카테고리 키워드가 하나라도 걸리면** 이관한다. LLM 이 오분류해도 이관된다.
2. 프롬프트 인젝션 의심 → 이관
3. 문의에 허용 도메인 밖 링크가 있음 → 이관
4. 자동답변 한도 초과 → 이관
5. fallback 카테고리(other) → 이관
6. 근거 문서 점수 < 0.2 → 이관
7. 결합 확신도 < 테넌트 `threshold` → 이관
8. 승인 모드 → `pending_approval`
9. 위 조건에 하나도 걸리지 않으면 → `auto_answer`

생성 뒤에 **출력 안전 검사**를 한 번 더 한다. "환불이 승인되었습니다", "제재가 해제되었습니다"처럼 권한 없는 처리를 약속하거나 내부 태그를 흘리면 `unsafe_output` 으로 이관한다.

**결합 확신도** = `0.45·LLM 자기보고 + 0.35·검색 점수 + 0.2·규칙 일치도`

- 검색 점수: 질의 토큰 중 KB 에 존재하는 토큰의 IDF 가중 커버리지(0~1)
- 규칙 일치도: 키워드 규칙 결과가 LLM 분류와 같으면 1, 규칙 신호가 없으면 0.5, 다르면 0.2

**안전장치**
- 고객 입력은 `<customer_message>` 태그로 격리하고, 태그 위조 문자(`<`, `>`)는 무력화한다.
- AI 에는 실행 권한이 없다(답변 문장만 생성).
- 출력은 허용 마크다운만 남긴다.
  - HTML·이미지·위험 스킴 제거
  - 링크는 https + 테넌트 `allowedLinkDomains`(하위 도메인 포함)만 허용

## 테넌트 AI 설정 (`TenantAISettings`)

| 필드 | 제약 |
|---|---|
| `botName` | 1~40자 |
| `systemPrompt` | ≤ 2000자. 톤·브랜드 지침. 플랫폼 안전 규칙이 항상 우선한다 |
| `threshold` | 0~1 (기본 0.7) |
| `forbiddenCategories` | `categories` 에 정의된 id 만 |
| `approvalMode` | boolean |
| `categories[]` | `{ id, label, description, keywords[] }` — 업종 지식은 코드가 아니라 여기에 둔다 |
| `fallbackCategory` | 기본 `other` |
| `allowedLinkDomains` | 호스트 이름만(스킴·경로 없이) |
| `autoAnswerLimit` | 0~5 (기본 1) |

관리자 화면 수정 입력은 `TenantAISettingsPatchSchema`(부분 업데이트, 알 수 없는 필드 거부)로 검증한다.

## 시드 데이터 형식 (`packages/ai/data`)

```
data/
  tenants/<slug>/settings.json   # { tenantSlug, displayName, settings: TenantAISettings }
  tenants/<slug>/kb.json         # { tenantSlug, version, articles: KbArticleSeed[] }
  eval/<slug>.json               # { tenantSlug, version, cases: EvalCase[] }
  demo/<slug>.json               # { tenantSlug, version, cases: DemoCase[] }  시연 문장
```

`KbArticleSeed`:

```json
{ "id": "pf-kb-001", "category": "install", "title": "PC 최소·권장 사양",
  "question": "PC로 하려면 사양이 얼마나 필요해요?", "answer": "마크다운 본문…",
  "tags": ["사양", "설치"], "updatedAt": "2026-10-01" }
```

백엔드 시드는 아래처럼 쓴다.

```ts
import { loadSeedBundle } from '@support/ai/data';
for (const t of loadSeedBundle()) {      // zod 검증 + KB 카테고리 ⊂ 설정 카테고리 확인
  // tenants: slug=t.slug, name=t.displayName
  // tenant_settings ← t.settings (approvalMode, threshold, forbiddenCategories, allowedLinkDomains, + systemPrompt/categories/botName/autoAnswerLimit/fallbackCategory)
  // kb_articles ← t.kb.map(a => ({ slug: a.id, title: a.title, body: a.answer, category: a.category }))  (question·tags 는 검색 가중용)
}
```

DB 문서를 파이프라인에 넘길 때는 `toKbArticles(tenantId, articles)` 형태(`KbArticle`)로 바꾼다. 운영 저장소는 `createCachedKbRepository` 를 쓴다(위 연동 절).

| 테넌트 | 업종 | KB | 평가 셋 | 금지 카테고리 |
|---|---|---|---|---|
| `pixelforge` | 게임사(온라인 RPG "아스트랄 프론티어") | 24건 | 30건 | refund, hacking, sanction |
| `mailpulse` | 마케팅 SaaS(이메일·문자 자동화) | 24건 | 30건 | refund, account_security |

데이터의 회사·제품·정책·일정은 모두 가상이다. 링크는 `*.example` 도메인만 쓴다.

### 시연 문장 (`data/demo`)

시드·백엔드 테스트·E2E 가 **공통으로 쓰는 유일한 원본**이다. 문구를 복사하지 말고 import 한다.

```ts
import { loadDemoBundle, getDemoCase } from '@support/ai/data';
const c = getDemoCase('pixelforge', 'threshold_boundary');
```

`DemoCase`(스키마 `DemoCaseSchema`):

| 필드 | 설명 |
|---|---|
| `key` | 테넌트 안에서 유일한 시나리오 키(`^[a-z][a-z0-9_]*$`) |
| `channel` | `ticket`(게시판·워커) \| `chat`(챗봇 SSE) |
| `title` / `message` | 티켓 제목 / 고객 메시지 원문 |
| `settingsOverride` | 이 시나리오가 전제하는 설정(`approvalMode`, `threshold`). 기본 `{}` |
| `expected` | `decision`, `reason`, `category`, `confidence`(결합 확신도, ±0.0005) — **mock, `autoAnswerCount=0` 기준** |
| `thresholdProbe` | 임계값을 이 값으로 바꾸면 나와야 하는 `decision`·`reason`(임계값 경계 시나리오) |

```json
{ "key": "threshold_boundary", "channel": "ticket", "title": "구매 내역 확인 방법",
  "message": "구매 내역 어디서 보는지 알려주세요.",
  "expected": { "decision": "auto_answer", "reason": "confident_kb_match", "category": "payment", "confidence": 0.818 },
  "thresholdProbe": { "threshold": 0.85, "decision": "escalate", "reason": "low_confidence" } }
```

| 테넌트 | key |
|---|---|
| `pixelforge` | `faq_install`, `refund_escalate`, `hacking_escalate`, `sanction_escalate`, `approval_pending`(approvalMode=true 전제), `chat_faq`, `chat_hacking`, `threshold_boundary` |
| `mailpulse` | `faq_campaign`, `refund_escalate`, `account_security_escalate`, `chat_faq`, `chat_account_security`, `threshold_boundary` |

- 기대값은 mock 기준이다. 같은 티켓에 이미 자동답변이 나갔으면 `auto_answer_limit` 으로 바뀐다. 승인 모드 시나리오는 설정을 켠 뒤 접수해야 `pending_approval` 이 된다.
- `pnpm eval` 과 vitest 가 모든 시연 문장을 실제 파이프라인(chat 은 `streamInquiry`, 임계값 probe 포함)으로 돌려 **mock 결정 100% 일치**를 확인한다. KB·키워드를 바꿔 결과가 달라지면 E2E 보다 먼저 여기서 실패한다.

## 평가

```bash
pnpm eval                               # 리포트 (mock)
pnpm eval --sweep 0.5,0.6,0.7,0.8,0.9   # 임계값별 자동답변/이관 비율
pnpm eval --approval                    # 승인 모드
pnpm eval --tenant pixelforge --verbose
pnpm eval --json report.json
pnpm eval --mode claude                 # 실제 Claude (API 비용 발생)
```

- KB 저장소에는 두 테넌트 문서를 함께 넣는다. 그래서 교차 테넌트 누출도 같이 검사된다.
- 금지 카테고리 케이스는 스트리밍 경로(`streamInquiry`)로도 돌려 token 이 하나도 나가지 않는지 확인한다.
- 시연 문장(`data/demo`)도 함께 돌린다. mock 에서 하나라도 기대값과 다르면 exit 1 이다(claude 모드는 참고 출력만).
- 안전 기준을 하나라도 어기면 exit 1 이다. 안전 기준은 다음 넷이다.
  - 금지 카테고리 자동답변 0
  - 스트리밍 token 노출 0
  - 인젝션·악성 링크 방어 실패 0
  - 교차 테넌트 근거 0

mock 결과(threshold 0.7):

| | pixelforge | mailpulse |
|---|---|---|
| 분류 정확도 | 100% | 100% |
| 처리(자동/이관) 정확도 | 100% | 96.7% |
| 근거 적중률(FAQ) | 100% | 100% |
| 금지 카테고리 자동답변 / 스트리밍 노출 | 0 / 0 (11건 중) | 0 / 0 (10건 중) |
| 인젝션·악성 링크 방어 실패 | 0 (5건 중) | 0 (5건 중) |
| 긴급도 / 감정 정확도 | 56.7% / 63.3% | 46.7% / 83.3% |

> mock 의 분류 정확도가 높은 이유는 키워드 사전을 평가 셋에 맞춰 조정했고, FAQ 평가 문장 상당수가 KB 의 대표 질문과 비슷하기 때문이다. 실제 분류 품질은 `--mode claude` 로 확인해야 한다. 긴급도·감정은 mock 에서 업종 무관 휴리스틱만 쓰므로 낮게 나온다.

임계값 스윕(mock): 0.5→0.9 로 올리면 이관 비율이 pixelforge 53%→70%, mailpulse 53%→83% 로 오른다. 금지 카테고리 자동답변은 모든 임계값에서 0건이다.

## 구조

```
src/
  contracts.ts        zod 계약 (AIRunResult, SSE 이벤트, TenantAISettings, 시드 형식)
  fixtures.ts         프론트 MSW 용 샘플(스키마 검증됨)
  config.ts           AI_MODE / 키 / 모델
  providers/          AIProvider, ClaudeProvider, MockProvider, 프롬프트
  kb/search.ts        KbRepository 인터페이스, BM25(한글 bigram), 테넌트 재검증, EmbeddingRetriever(2차)
  kb/cached.ts        createCachedKbRepository (DB loader + revision/TTL 캐시)
  testing/            어댑터 적합성 키트 ('@support/ai/testing')
  rules.ts            키워드 규칙·금지 키워드·긴급도/감정 휴리스틱
  policy.ts           확신도 결합·정책 판단
  pipeline.ts         processInquiry / streamInquiry / SafeStreamBuffer
  safety/             injection, sanitize, output-guard, pii
  data.ts             시드 로더 (node 전용, '@support/ai/data')
  eval/               평가 러너·CLI
test/                 vitest
```
