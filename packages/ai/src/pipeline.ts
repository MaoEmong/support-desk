/**
 * AI 파이프라인 진입점.
 *   processInquiry  — 게시판(티켓) 작업 큐용. 항상 AIRunResult 를 반환한다(오류도 결과에 담아 이관).
 *   streamInquiry   — 챗봇 SSE 용. 분류·정책 판단을 먼저 끝내고, 자동답변이 허용된 경우에만 token 을 흘린다.
 * 이 패키지는 DB 에 쓰지 않는다. 필요한 데이터는 전부 deps 로 주입받고, 저장은 호출한 백엔드가 한다.
 */
import type {
  AIDraft,
  AIRunError,
  AIRunResult,
  AIUsage,
  ClassificationResult,
  ConfidenceBreakdown,
  ProcessInquiryInput,
  SSEEvent,
  Source,
  TenantAISettings,
} from './contracts';
import { PIPELINE_VERSION, ProcessInquiryInputSchema } from './contracts';
import { AIConfigError } from './config';
import type { KbArticle, KbHit, KbRepository } from './kb/search';
import { assertTenantScoped, TenantMismatchError } from './kb/search';
import { combineConfidence, customerNotice, decide, type PolicyDecision } from './policy';
import type { AIProvider, GenerateMode } from './providers/types';
import { ProviderError, ProviderRefusalError } from './providers/types';
import { forbiddenKeywordHits, ruleAgreement, scoreKeywords } from './rules';
import { detectInjection } from './safety/injection';
import { checkOutputSafety } from './safety/output-guard';
import { findDisallowedUrls, sanitizeOutput } from './safety/sanitize';
import { excerpt } from './text';

// ---------------------------------------------------------------------------
// 주입 인터페이스
// ---------------------------------------------------------------------------

export interface InquiryContext {
  message: { id: string; body: string };
  /** 이 티켓/대화에서 이미 고객에게 나간 AI 자동답변 수 */
  autoAnswerCount: number;
}

export interface InquiryReader {
  /** tenantId 범위 안에서 메시지를 찾는다. 없거나 다른 테넌트면 null. */
  getInquiryContext(input: ProcessInquiryInput): Promise<InquiryContext | null>;
}

export interface SettingsReader {
  getTenantAISettings(tenantId: string): Promise<TenantAISettings | null>;
}

export interface PipelineLogger {
  info(msg: string, meta?: Record<string, unknown>): void;
  warn(msg: string, meta?: Record<string, unknown>): void;
  error(msg: string, meta?: Record<string, unknown>): void;
}

export interface PipelineDeps {
  provider: AIProvider;
  kb: KbRepository;
  inquiries: InquiryReader;
  settings: SettingsReader;
  /** 검색 결과 개수(기본 3) */
  sourceLimit?: number;
  now?: () => number;
  /** 운영 로그. 메시지 원문은 넘기지 않는다(필요하면 maskPII 후 사용). */
  logger?: PipelineLogger;
}

// ---------------------------------------------------------------------------
// 공통 준비 단계: 분류 → 검색 → 정책
// ---------------------------------------------------------------------------

interface Prepared {
  input: ProcessInquiryInput;
  settings: TenantAISettings;
  message: string;
  classification: ClassificationResult;
  hits: KbHit[];
  sources: Source[];
  confidence: ConfidenceBreakdown;
  policy: PolicyDecision;
  injectionSuspected: boolean;
  suspiciousLinks: string[];
  usage: AIUsage[];
  timing: { classifyMs: number; retrieveMs: number };
}

class PipelineFailure extends Error {
  constructor(
    readonly runError: AIRunError,
    readonly partial: Partial<Prepared> = {},
  ) {
    super(runError.message);
  }
}

function toRunError(err: unknown): AIRunError {
  if (err instanceof PipelineFailure) return err.runError;
  if (err instanceof AIConfigError) return { code: 'CONFIG_ERROR', message: err.message };
  if (err instanceof ProviderRefusalError) return { code: 'PROVIDER_REFUSAL', message: err.message };
  if (err instanceof ProviderError) return { code: 'PROVIDER_ERROR', message: err.message };
  if (err instanceof TenantMismatchError) return { code: 'TENANT_MISMATCH', message: err.message };
  return { code: 'INTERNAL', message: err instanceof Error ? err.message : String(err) };
}

function toSource(hit: KbHit): Source {
  return {
    kbArticleId: hit.article.id,
    title: hit.article.title,
    excerpt: excerpt(hit.article.body, 160),
    tenantId: hit.article.tenantId,
    score: Math.round(hit.score * 1000) / 1000,
  };
}

async function prepare(rawInput: ProcessInquiryInput, deps: PipelineDeps, now: () => number, signal?: AbortSignal): Promise<Prepared> {
  const parsed = ProcessInquiryInputSchema.safeParse(rawInput);
  if (!parsed.success) {
    throw new PipelineFailure({ code: 'INTERNAL', message: `잘못된 입력: ${parsed.error.issues.map((i) => i.message).join('; ')}` });
  }
  const input = parsed.data;

  const [settings, context] = await Promise.all([
    deps.settings.getTenantAISettings(input.tenantId),
    deps.inquiries.getInquiryContext(input),
  ]);
  if (!settings) throw new PipelineFailure({ code: 'NOT_FOUND', message: '테넌트 AI 설정을 찾을 수 없습니다' });
  if (!context) throw new PipelineFailure({ code: 'NOT_FOUND', message: '문의 메시지를 찾을 수 없습니다' });
  if (context.message.id !== input.messageId) {
    throw new PipelineFailure({ code: 'NOT_FOUND', message: '요청한 메시지와 조회된 메시지가 다릅니다' });
  }

  const message = context.message.body;
  const injection = detectInjection(message);
  const suspiciousLinks = findDisallowedUrls(message, settings.allowedLinkDomains);
  const usage: AIUsage[] = [];

  // 1) 분류
  const t0 = now();
  const classified = await deps.provider.classify({ settings, message, ...(signal ? { signal } : {}) });
  usage.push(classified.usage);
  let classification = classified.value;
  if (!settings.categories.some((c) => c.id === classification.category)) {
    classification = { ...classification, category: settings.fallbackCategory, confidence: Math.min(classification.confidence, 0.2) };
  }
  const classifyMs = now() - t0;

  // 2) 테넌트 KB 검색 + 소속 재검증
  const t1 = now();
  const hits = await deps.kb.search({
    tenantId: input.tenantId,
    query: message,
    limit: deps.sourceLimit ?? 3,
    preferCategory: classification.category,
  });
  try {
    assertTenantScoped(input.tenantId, hits);
  } catch (err) {
    deps.logger?.error('kb.tenant_mismatch', { tenantId: input.tenantId, error: (err as Error).message });
    throw new PipelineFailure(toRunError(err), { settings, classification, usage, injectionSuspected: injection.suspected, suspiciousLinks });
  }
  const retrieveMs = now() - t1;

  // 3) 확신도 결합 + 정책
  const keywordScores = scoreKeywords(settings, message);
  const topScore = hits[0]?.score ?? 0;
  const confidence = combineConfidence({
    llm: classification.confidence,
    retrieval: topScore,
    rule: ruleAgreement(keywordScores, classification.category),
  });
  const policy = decide({
    settings,
    category: classification.category,
    forbiddenKeywordCategories: forbiddenKeywordHits(settings, keywordScores),
    injectionSuspected: injection.suspected,
    suspiciousLinks,
    autoAnswerCount: context.autoAnswerCount,
    topSourceScore: topScore,
    confidence,
  });

  return {
    input,
    settings,
    message,
    classification,
    hits,
    sources: hits.map(toSource),
    confidence,
    policy,
    injectionSuspected: injection.suspected,
    suspiciousLinks,
    usage,
    timing: { classifyMs, retrieveMs },
  };
}

function generateMode(policy: PolicyDecision): GenerateMode {
  return policy.decision === 'escalate' ? 'agent_draft' : 'customer_answer';
}

function articlesFor(p: Prepared): KbArticle[] {
  return p.hits.map((h) => h.article);
}

/** 생성 결과를 sanitize 하고 출력 안전 검사로 정책을 보정한다. */
function finalizeDraft(p: Prepared, rawText: string, model: string): { draft: AIDraft; policy: PolicyDecision; removedLinks: string[] } {
  const { text, removedLinks } = sanitizeOutput(rawText, p.settings.allowedLinkDomains);
  let policy = p.policy;
  if (policy.decision !== 'escalate') {
    const guard = checkOutputSafety(text);
    if (!guard.safe) {
      policy = { decision: 'escalate', reason: 'unsafe_output', detail: `출력 안전 검사 위반: ${guard.violations.join(', ')}` };
    }
  }
  return {
    draft: { body: text, sources: p.sources, model, customerVisible: policy.decision === 'auto_answer' },
    policy,
    removedLinks,
  };
}

const ZERO_CONFIDENCE: ConfidenceBreakdown = { final: 0, llm: 0, retrieval: 0, rule: 0 };

function buildResult(args: {
  input: ProcessInquiryInput;
  prepared?: Partial<Prepared>;
  policy: PolicyDecision;
  draft: AIDraft | null;
  usage: AIUsage[];
  timing: { classifyMs: number; retrieveMs: number; generateMs: number; totalMs: number };
  removedLinks: string[];
  error: AIRunError | null;
}): AIRunResult {
  const p = args.prepared ?? {};
  return {
    pipelineVersion: PIPELINE_VERSION,
    tenantId: args.input.tenantId,
    ...(args.input.ticketId ? { ticketId: args.input.ticketId } : {}),
    ...(args.input.conversationId ? { conversationId: args.input.conversationId } : {}),
    messageId: args.input.messageId,
    decision: args.policy.decision,
    reason: args.policy.reason,
    reasonDetail: args.policy.detail,
    classification: p.classification ?? null,
    confidence: p.confidence ?? ZERO_CONFIDENCE,
    sources: args.error?.code === 'TENANT_MISMATCH' ? [] : (p.sources ?? []),
    draft: args.draft,
    usage: args.usage,
    timing: args.timing,
    flags: {
      injectionSuspected: p.injectionSuspected ?? false,
      suspiciousLinks: p.suspiciousLinks ?? [],
      removedOutputLinks: args.removedLinks,
    },
    error: args.error,
  };
}

function errorPolicy(error: AIRunError): PolicyDecision {
  if (error.code === 'PROVIDER_REFUSAL') {
    return { decision: 'escalate', reason: 'provider_refusal', detail: '모델이 응답을 거부하여 상담원 처리' };
  }
  return { decision: 'escalate', reason: 'ai_error', detail: `AI 처리 실패(${error.code}) — 상담원 처리` };
}

// ---------------------------------------------------------------------------
// processInquiry: 게시판 작업 큐용
// ---------------------------------------------------------------------------

export async function processInquiry(input: ProcessInquiryInput, deps: PipelineDeps): Promise<AIRunResult> {
  const now = deps.now ?? (() => performance.now());
  const start = now();
  let prepared: Prepared | undefined;
  try {
    prepared = await prepare(input, deps, now);
    const t2 = now();
    const generated = await deps.provider.generate({
      settings: prepared.settings,
      message: prepared.message,
      classification: prepared.classification,
      articles: articlesFor(prepared),
      mode: generateMode(prepared.policy),
    });
    const generateMs = now() - t2;
    const { draft, policy, removedLinks } = finalizeDraft(prepared, generated.value, generated.usage.model);
    return buildResult({
      input,
      prepared,
      policy,
      draft,
      usage: [...prepared.usage, generated.usage],
      timing: { ...prepared.timing, generateMs, totalMs: now() - start },
      removedLinks,
      error: null,
    });
  } catch (err) {
    const error = toRunError(err);
    deps.logger?.warn('ai.pipeline_failed', { tenantId: input.tenantId, code: error.code });
    const partial = err instanceof PipelineFailure ? { ...err.partial, ...(prepared ?? {}) } : (prepared ?? {});
    return buildResult({
      input,
      prepared: partial,
      policy: errorPolicy(error),
      draft: null,
      usage: partial.usage ?? [],
      timing: { classifyMs: partial.timing?.classifyMs ?? 0, retrieveMs: partial.timing?.retrieveMs ?? 0, generateMs: 0, totalMs: now() - start },
      removedLinks: [],
      error,
    });
  }
}

// ---------------------------------------------------------------------------
// streamInquiry: 챗봇 SSE 용
// ---------------------------------------------------------------------------

/**
 * 스트림 안전 버퍼: 생성 조각을 모았다가 "문장 경계"에서만 내보낸다.
 * 내보내기 전에 sanitize·출력 안전 검사를 거치므로, 위반 문장은 고객 화면에 도달하지 않는다.
 */
export class SafeStreamBuffer {
  private pending = '';
  private released = '';
  readonly removedLinks: string[] = [];

  constructor(private readonly allowedDomains: readonly string[]) {}

  /** 새 조각을 넣고, 내보낼 수 있는 안전한 텍스트를 돌려준다. 위반이면 { unsafe } */
  push(chunk: string): { text: string } | { unsafe: string[] } {
    this.pending += chunk;
    const cut = this.lastBoundary(this.pending);
    if (cut <= 0) return { text: '' };
    return this.release(this.pending.slice(0, cut), this.pending.slice(cut));
  }

  flush(): { text: string } | { unsafe: string[] } {
    return this.release(this.pending, '');
  }

  get text(): string {
    return this.released;
  }

  private release(segment: string, rest: string): { text: string } | { unsafe: string[] } {
    if (!segment) return { text: '' };
    const { text, removedLinks } = sanitizeOutput(segment, this.allowedDomains);
    const guard = checkOutputSafety(this.released + text);
    if (!guard.safe) return { unsafe: guard.violations };
    this.removedLinks.push(...removedLinks);
    // sanitize 는 앞뒤 공백을 다듬으므로 문장·문단 구분 공백을 되살린다.
    const lead = this.released ? (segment.match(/^\s+/)?.[0] ?? '') : '';
    const trail = text ? (segment.match(/\s+$/)?.[0] ?? '') : '';
    const out = text ? lead + text + trail : '';
    this.released += out;
    this.pending = rest;
    return { text: out };
  }

  /**
   * 줄바꿈 또는 [.!?] + 공백 위치. 경계 뒤 공백까지 이번 조각에 포함해서 토큰 사이 공백이 사라지지 않게 한다.
   * 열린 [ ( 가 있으면 링크가 끝날 때까지 기다린다.
   */
  private lastBoundary(s: string): number {
    for (let i = s.length - 1; i >= 0; i--) {
      const ch = s[i];
      const boundary = ch === '\n' || ((ch === '.' || ch === '!' || ch === '?') && /\s/.test(s[i + 1] ?? ''));
      if (!boundary) continue;
      const head = s.slice(0, i + 1);
      const opens = (head.match(/\[/g)?.length ?? 0) + (head.match(/\(/g)?.length ?? 0);
      const closes = (head.match(/\]/g)?.length ?? 0) + (head.match(/\)/g)?.length ?? 0);
      if (opens !== closes) continue;
      let end = i + 1;
      while (end < s.length && /\s/.test(s[end]!)) end++;
      return end;
    }
    return -1;
  }
}

export interface StreamInquiryOptions {
  /**
   * 고객 연결이 끊기면 abort 한다. 중단되면:
   * - provider 호출(분류·생성·스트림)을 취소하고
   * - 이후 token 을 내보내지 않으며
   * - done(·error) 없이 generator 를 끝낸다. 호출자는 done 을 받은 경우에만 결과를 저장한다.
   */
  signal?: AbortSignal;
}

const ABORTED = Symbol('aborted');

/** gen.next() 와 취소 중 먼저 오는 쪽. 취소가 이기면 남은 next 의 실패는 조용히 버린다. */
function nextOrAbort<T, R>(gen: AsyncGenerator<T, R, void>, signal?: AbortSignal): Promise<IteratorResult<T, R> | typeof ABORTED> {
  if (!signal) return gen.next();
  if (signal.aborted) return Promise.resolve(ABORTED);
  const next = gen.next();
  next.catch(() => undefined);
  return new Promise((resolve, reject) => {
    const onAbort = () => resolve(ABORTED);
    signal.addEventListener('abort', onAbort, { once: true });
    next.then(
      (v) => {
        signal.removeEventListener('abort', onAbort);
        resolve(v);
      },
      (e: unknown) => {
        signal.removeEventListener('abort', onAbort);
        reject(e instanceof Error ? e : new Error(String(e)));
      },
    );
  });
}

/** 실행 중이어도 기다리지 않고 provider generator 를 닫는다(finally 에서 HTTP 스트림 abort). */
function closeQuietly<T, R>(gen: AsyncGenerator<T, R, void>): void {
  gen.return(undefined as R).catch(() => undefined);
}

export async function* streamInquiry(
  input: ProcessInquiryInput,
  deps: PipelineDeps,
  options: StreamInquiryOptions = {},
): AsyncGenerator<SSEEvent, void, void> {
  const { signal } = options;
  const aborted = () => signal?.aborted === true;
  const now = deps.now ?? (() => performance.now());
  const start = now();
  if (aborted()) return;
  let prepared: Prepared | undefined;
  try {
    prepared = await prepare(input, deps, now, signal);
  } catch (err) {
    if (aborted()) return;
    const error = toRunError(err);
    const partial = err instanceof PipelineFailure ? err.partial : {};
    yield { type: 'error', code: error.code, message: '일시적인 문제로 답변을 만들지 못했어요. 상담원에게 연결해 드릴게요.' };
    yield {
      type: 'done',
      result: buildResult({
        input,
        prepared: partial,
        policy: errorPolicy(error),
        draft: null,
        usage: partial.usage ?? [],
        timing: { classifyMs: 0, retrieveMs: 0, generateMs: 0, totalMs: now() - start },
        removedLinks: [],
        error,
      }),
    };
    return;
  }

  if (aborted()) return;
  yield { type: 'classified', classification: prepared.classification };
  if (aborted()) return;

  // 자동답변이 아니면 고객에게는 안내만 보내고, 상담원용 초안은 비스트리밍으로 만든다.
  if (prepared.policy.decision !== 'auto_answer') {
    const decision = prepared.policy.decision;
    yield { type: 'escalated', decision, reason: prepared.policy.reason, notice: customerNotice(decision) };
    if (aborted()) return;
    let draft: AIDraft | null = null;
    let removedLinks: string[] = [];
    const usage = [...prepared.usage];
    let error: AIRunError | null = null;
    const t2 = now();
    try {
      const generated = await deps.provider.generate({
        settings: prepared.settings,
        message: prepared.message,
        classification: prepared.classification,
        articles: articlesFor(prepared),
        mode: generateMode(prepared.policy),
        ...(signal ? { signal } : {}),
      });
      if (aborted()) return;
      usage.push(generated.usage);
      const fin = finalizeDraft(prepared, generated.value, generated.usage.model);
      // 이미 고객에게 이관/승인대기로 안내했으므로 결정은 바꾸지 않되, 초안은 고객 비노출로 고정한다.
      draft = { ...fin.draft, customerVisible: false };
      removedLinks = fin.removedLinks;
    } catch (err) {
      if (aborted()) return;
      error = toRunError(err); // 초안 실패는 결과에만 기록(이관 결정은 유지)
    }
    yield {
      type: 'done',
      result: buildResult({
        input,
        prepared,
        policy: prepared.policy,
        draft,
        usage,
        timing: { ...prepared.timing, generateMs: now() - t2, totalMs: now() - start },
        removedLinks,
        error,
      }),
    };
    return;
  }

  // 자동답변: 근거 → 안전 버퍼를 거친 토큰 스트림
  yield { type: 'sources', sources: prepared.sources };
  if (aborted()) return;
  const buffer = new SafeStreamBuffer(prepared.settings.allowedLinkDomains);
  const usage = [...prepared.usage];
  const t2 = now();
  let policy: PolicyDecision = prepared.policy;
  let error: AIRunError | null = null;
  let model: string = deps.provider.model;
  const gen = deps.provider.streamGenerate({
    settings: prepared.settings,
    message: prepared.message,
    classification: prepared.classification,
    articles: articlesFor(prepared),
    mode: 'customer_answer',
    ...(signal ? { signal } : {}),
  });
  let genFinished = false;
  try {
    let unsafe: string[] | null = null;
    while (true) {
      const step = await nextOrAbort(gen, signal);
      if (step === ABORTED) return;
      if (step.done) {
        genFinished = true;
        usage.push(step.value);
        model = step.value.model;
        break;
      }
      const out = buffer.push(step.value);
      if ('unsafe' in out) {
        unsafe = out.unsafe;
        genFinished = true;
        closeQuietly(gen);
        break;
      }
      if (out.text) {
        yield { type: 'token', text: out.text };
        if (aborted()) return;
      }
    }
    if (aborted()) return;
    if (!unsafe) {
      const tail = buffer.flush();
      if ('unsafe' in tail) unsafe = tail.unsafe;
      else if (tail.text) yield { type: 'token', text: tail.text };
      if (aborted()) return;
    }
    if (unsafe) {
      policy = { decision: 'escalate', reason: 'unsafe_output', detail: `출력 안전 검사 위반: ${unsafe.join(', ')}` };
      yield { type: 'escalated', decision: 'escalate', reason: 'unsafe_output', notice: customerNotice('escalate') };
      if (aborted()) return;
    }
  } catch (err) {
    genFinished = true; // 예외로 끝난 generator 는 이미 닫혀 있다
    if (aborted()) return;
    error = toRunError(err);
    policy = errorPolicy(error);
    yield { type: 'error', code: error.code, message: '답변 중 문제가 생겼어요. 상담원에게 연결해 드릴게요.' };
  } finally {
    // 취소·소비 중단(for-await break 포함) 시 provider 스트림을 닫는다.
    if (!genFinished) closeQuietly(gen);
  }
  if (aborted()) return;

  const draft: AIDraft = {
    body: buffer.text,
    sources: prepared.sources,
    model,
    customerVisible: policy.decision === 'auto_answer',
  };
  yield {
    type: 'done',
    result: buildResult({
      input,
      prepared,
      policy,
      draft,
      usage,
      timing: { ...prepared.timing, generateMs: now() - t2, totalMs: now() - start },
      removedLinks: buffer.removedLinks,
      error,
    }),
  };
}
