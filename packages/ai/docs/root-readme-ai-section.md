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

현재 결과(mock): 4가지 모두 0, 시연 문장 14/14 일치.

### 시연 문장 (`data/demo`)

- 시드·백엔드 테스트·E2E 가 공통으로 쓰는 유일한 원본이다. 문구를 복사하지 않는다.
  `import { getDemoCase, loadDemoBundle } from '@support/ai/data'`
- 형식(`DemoCaseSchema`): `key`, `channel`(`ticket`|`chat`), `title`, `message`, `settingsOverride`(`approvalMode`, `threshold`),
  `expected`(`decision`, `reason`, `category`, `confidence` ±0.0005 — mock, autoAnswerCount=0 기준), `thresholdProbe`(임계값 경계)
- pixelforge 8건: FAQ, 환불·해킹·제재 이관, 승인 모드, 챗봇 FAQ·해킹, 임계값 경계(0.818: 0.7 에서 자동답변, 0.85 에서 이관). mailpulse 6건.
- `pnpm --filter @support/ai eval` 과 vitest 가 실제 파이프라인으로 mock 결과 100% 일치를 검증한다.

자세한 연동 인터페이스(processInquiry, streamInquiry `signal`, createCachedKbRepository·kbRevision, `@support/ai/testing`, 설정 행 매퍼)는 `packages/ai/README.md` 에 있다.
