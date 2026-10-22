import type { SSEEvent } from '@support/ai';
import { sampleRunPendingApproval, sampleSSEAutoAnswer, sampleSSEEscalated } from '@support/ai/fixtures';
import { describe, expect, it } from 'vitest';
import type { ChatResponder } from '../ai/chat';
import { loadConfig } from '../config';
import { MemoryRepo } from '../repo/memory';
import { loginAs, makeWorld, ORIGIN, parseSse, testConfig, type Client, type World } from './helpers';

/** 끊기 시험용: 쿠키·CSRF를 실은 채팅 요청에 AbortSignal을 단다 */
function chatRequest(c: Client, signal: AbortSignal, body: unknown) {
  return new Request(`${ORIGIN}/api/t/game/chat`, {
    method: 'POST',
    headers: {
      origin: ORIGIN,
      'content-type': 'application/json',
      cookie: [...c.cookies].map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('; '),
      'x-csrf-token': c.csrf!,
    },
    body: JSON.stringify(body),
    signal,
  });
}

const FIXTURE_TENANT = 'tenant-pixelforge';
/** 고객 공개 스트림에 나오면 안 되는 내부 분석 키 */
const INTERNAL_KEYS = ['confidence', 'urgency', 'sentiment', 'summary', 'score', 'tenantId', 'reasonDetail', 'decision', 'usage', 'pipelineVersion', 'result'];

/**
 * 공식 fixture 이벤트를 그대로 재생한다. 근거의 fixture 테넌트 id만 실제 테넌트 id로 바꾼다
 * (서버가 다른 테넌트 근거를 거르므로). done.result의 ID도 이번 요청 값으로 맞춘다.
 */
function replay(w: World, events: SSEEvent[]): ChatResponder {
  const tenant = <T extends { tenantId: string }>(s: T): T => ({ ...s, tenantId: s.tenantId === FIXTURE_TENANT ? w.tenantA.id : s.tenantId });
  return {
    async *respond(input) {
      for (const ev of events) {
        if (ev.type === 'sources') yield { ...ev, sources: ev.sources.map(tenant) };
        else if (ev.type === 'done') {
          const r = ev.result;
          yield {
            ...ev,
            result: {
              ...r,
              tenantId: input.tenantId,
              conversationId: input.conversationId,
              messageId: input.messageId,
              sources: r.sources.map(tenant),
              draft: r.draft ? { ...r.draft, sources: r.draft.sources.map(tenant) } : null,
            },
          };
        } else yield ev;
      }
    },
  };
}

/** World(테넌트 id)를 만든 뒤에 실제 응답기를 꽂기 위한 위임 응답기 */
let late: ChatResponder;
function lateResponder(): ChatResponder {
  return { respond: (i, s) => late.respond(i, s) };
}

const approvalEvents: SSEEvent[] = [
  sampleSSEAutoAnswer[0]!,
  { type: 'escalated', decision: 'pending_approval', reason: 'approval_mode', notice: '답변을 준비했어요. 상담원 확인을 거쳐 곧 전달드릴게요.' },
  { type: 'done', result: { ...sampleRunPendingApproval, ticketId: undefined, conversationId: 'conv-x' } },
];

describe('챗봇 SSE 공개 변환', () => {
  it('AI 미연동 스텁: classified → escalated → done, token 없음, system 메시지 저장', async () => {
    const w = makeWorld();
    const c = await loginAs(w, 'custA1');
    const res = await c.post('/t/game/chat', { body: '환불해주세요' });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    expect(res.headers.get('x-accel-buffering')).toBe('no');
    const events = parseSse(res.text);
    expect(events.map((e) => e.event)).toEqual(['classified', 'escalated', 'done']);
    const conversationId = events.at(-1)!.data.conversationId;
    expect(events[0]!.data).toEqual({ category: 'other', conversationId });
    const conv = await c.get(`/t/game/conversations/${conversationId}`);
    expect(conv.json.messages.map((m: { role: string }) => m.role)).toEqual(['user', 'system']);
  });

  it('자동답변(sampleSSEAutoAnswer): sources → token*, 공개 필드만, done은 IDs만, 내보낸 답변만 저장', async () => {
    const world = makeWorld({ chat: lateResponder() });
    late = replay(world, sampleSSEAutoAnswer);
    const c = await loginAs(world, 'custA1');
    const res = await c.post('/t/game/chat', { body: '최소 사양?' });
    const ev = parseSse(res.text);
    expect(ev.map((e) => e.event)).toEqual(['classified', 'sources', 'token', 'token', 'token', 'token', 'done']);
    expect(Object.keys(ev[0]!.data).sort()).toEqual(['category', 'conversationId']);
    const src = ev[1]!.data.sources;
    expect(src).toHaveLength(1);
    expect(Object.keys(src[0]).sort()).toEqual(['excerpt', 'id', 'title']);
    expect(src[0]).toMatchObject({ id: 'pf-kb-001', title: 'PC 최소·권장 사양' });
    const done = ev.at(-1)!.data;
    expect(Object.keys(done).sort()).toEqual(['conversationId', 'messageId']);
    for (const k of INTERNAL_KEYS) expect(res.text).not.toContain(`"${k}"`);

    const streamed = ev.filter((e) => e.event === 'token').map((e) => e.data.token).join('');
    const conv = await c.get(`/t/game/conversations/${done.conversationId}`);
    expect(conv.json.messages.at(-1)).toMatchObject({ id: done.messageId, role: 'assistant', body: streamed });
  });

  it('금지 문의(sampleSSEEscalated): token 0, escalated {reason, message}만, 분석 누출 없음', async () => {
    const world = makeWorld({ chat: lateResponder() });
    late = replay(world, sampleSSEEscalated);
    const c = await loginAs(world, 'custA1');
    const res = await c.post('/t/game/chat', { body: '환불해 주세요' });
    const ev = parseSse(res.text);
    expect(ev.map((e) => e.event)).toEqual(['classified', 'escalated', 'done']);
    expect(ev[1]!.data).toEqual({ reason: 'forbidden_category', message: '문의 내용을 담당 상담원에게 전달했어요. 확인 후 답변드릴게요.' });
    for (const k of INTERNAL_KEYS) expect(res.text).not.toContain(`"${k}"`);
    const conv = await c.get(`/t/game/conversations/${ev.at(-1)!.data.conversationId}`);
    expect(conv.json.messages.map((m: { role: string }) => m.role)).toEqual(['user', 'system']);
    // 고객 클릭 전까지 티켓 없음
    expect(world.repo.state.tickets).toHaveLength(0);
  });

  it('응답기가 이관 뒤에 token을 내도(순서 위반) 서버가 버린다', async () => {
    const world = makeWorld({ chat: lateResponder() });
    late = replay(world, [sampleSSEEscalated[0]!, sampleSSEEscalated[1]!, { type: 'token', text: '환불 처리해 드렸어요.' }, sampleSSEEscalated[2]!]);
    const c = await loginAs(world, 'custA1');
    const res = await c.post('/t/game/chat', { body: '환불' });
    expect(parseSse(res.text).some((e) => e.event === 'token')).toBe(false);
    expect(res.text).not.toContain('환불 처리해');
  });

  it('승인 모드 테넌트는 자동답변 이벤트가 와도 token·sources를 흘리지 않는다', async () => {
    const world = makeWorld({ chat: lateResponder() });
    late = replay(world, sampleSSEAutoAnswer);
    world.repo.state.settings.find((s) => s.tenantId === world.tenantA.id)!.approvalMode = true;
    const c = await loginAs(world, 'custA1');
    const res = await c.post('/t/game/chat', { body: '최소 사양?' });
    const names = parseSse(res.text).map((e) => e.event);
    expect(names).not.toContain('token');
    expect(names).not.toContain('sources');
    expect(res.text).not.toContain('최소 사양**');
  });

  it('승인 모드 안내(pending_approval) 후 티켓으로 자동 전환: 1건, escalated 기록, status open, ai_jobs 없음, 멱등', async () => {
    const world = makeWorld({ chat: lateResponder() });
    late = replay(world, approvalEvents);
    world.repo.state.settings.find((s) => s.tenantId === world.tenantA.id)!.approvalMode = true;
    const c = await loginAs(world, 'custA1');
    const ev = parseSse((await c.post('/t/game/chat', { body: '최소 사양?' })).text);
    expect(ev.map((e) => e.event)).toEqual(['classified', 'escalated', 'done']);
    expect(ev[1]!.data).toMatchObject({ reason: 'approval_mode' });
    const done = ev.at(-1)!.data;
    expect(done.ticketId).toBeTruthy();
    expect(world.repo.state.tickets).toHaveLength(1);
    expect(world.repo.state.tickets[0]).toMatchObject({ id: done.ticketId, status: 'open', conversationId: done.conversationId, escalationReason: 'approval_mode' });
    expect(world.repo.state.tickets[0]!.escalatedAt).not.toBeNull();
    expect(world.repo.state.jobs).toHaveLength(0);
    // 이후 수동 전환 요청도 같은 티켓(중복 없음)
    const again = await c.post(`/t/game/conversations/${done.conversationId}/convert`, { title: 'x' });
    expect(again.status).toBe(200);
    expect(again.json.ticketId).toBe(done.ticketId);
    expect(world.repo.state.tickets).toHaveLength(1);
  });

  it('heartbeat 기본 간격은 15000ms(운영 설정)', () => {
    expect(loadConfig({}).sseHeartbeatMs).toBe(15_000);
    expect(testConfig().sseHeartbeatMs).toBe(15_000);
  });

  it('heartbeat: 응답기 대기 중 주입 간격으로 ": keep-alive" 주석을 보내고, 공개 파서는 주석을 무시한다', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    // 운영 15초는 그대로 두고 테스트에서만 짧은 간격 주입(고정 sleep 없이 gate로 대기 구간을 만든다)
    const world = makeWorld({ chat: lateResponder(), cfg: { sseHeartbeatMs: 5 } });
    const rest = replay(world, sampleSSEEscalated.slice(1));
    late = {
      async *respond(i, s) {
        yield sampleSSEEscalated[0]!;
        await gate;
        yield* rest.respond(i, s);
      },
    };
    const c = await loginAs(world, 'custA1');
    const res = await world.app.handle(chatRequest(c, new AbortController().signal, { body: '환불' }));
    const reader = res.body!.getReader();
    const dec = new TextDecoder();
    let text = '';
    while (!text.includes(': keep-alive\n\n')) {
      const { value, done } = await reader.read();
      if (done) break;
      text += dec.decode(value, { stream: true });
    }
    expect(text).toContain(': keep-alive\n\n');
    release();
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      text += dec.decode(value, { stream: true });
    }
    // 주석은 이벤트가 아니다: 공개 이벤트 순서는 그대로
    expect(parseSse(text).map((e) => e.event)).toEqual(['classified', 'escalated', 'done']);
  });

  it('abort 경계① done 저장 tx 커밋 전에 끊기면 롤백: 고객 질문만 남고 assistant·run·draft 0', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let entered!: () => void;
    const inTx = new Promise<void>((r) => (entered = r));
    /** 저장 tx 안(createRun)에서 멈춰 커밋 전 끊김을 재현 */
    class GatedRepo extends MemoryRepo {
      override async createRun(...args: Parameters<MemoryRepo['createRun']>) {
        entered();
        await gate;
        return super.createRun(...args);
      }
    }
    const world = makeWorld({ chat: lateResponder(), repo: new GatedRepo() });
    late = replay(world, sampleSSEEscalated);
    const c = await loginAs(world, 'custA1');
    const ctrl = new AbortController();
    const res = await world.app.handle(chatRequest(c, ctrl.signal, { body: '환불' }));
    const reader = res.body!.getReader();
    const drain = (async () => {
      try {
        while (!(await reader.read()).done);
      } catch {
        /* 끊긴 스트림 */
      }
    })();
    await inTx;
    ctrl.abort();
    await reader.cancel().catch(() => undefined);
    release();
    await drain;
    await new Promise((r) => setTimeout(r, 10));
    expect(world.repo.state.conversationMessages.map((m) => m.role)).toEqual(['user']);
    expect(world.repo.state.runs).toHaveLength(0);
    expect(world.repo.state.drafts).toHaveLength(0);
  });

  it('abort 경계② done 저장 커밋 후 끊김은 저장 유지(삭제·중복 저장 없음), 같은 대화에 다시 질문 가능', async () => {
    const world = makeWorld({ chat: lateResponder() });
    late = replay(world, sampleSSEAutoAnswer);
    const c = await loginAs(world, 'custA1');
    const ctrl = new AbortController();
    const res = await world.app.handle(chatRequest(c, ctrl.signal, { body: '최소 사양?' }));
    const text = await res.text(); // done까지 받음 = 커밋 완료
    ctrl.abort();
    await new Promise((r) => setTimeout(r, 10));
    const done = parseSse(text).at(-1)!.data;
    expect(world.repo.state.conversationMessages.map((m) => m.role)).toEqual(['user', 'assistant']);
    expect(world.repo.state.runs).toHaveLength(1);
    const again = await c.post('/t/game/chat', { conversationId: done.conversationId, body: '하나 더' });
    expect(again.status).toBe(200);
    expect(world.repo.state.conversationMessages.map((m) => m.role)).toEqual(['user', 'assistant', 'user', 'assistant']);
    expect(world.repo.state.runs).toHaveLength(2);
  });

  it('고객이 연결을 끊으면 응답기에 abort가 전파되고 부분 답변은 저장되지 않는다', async () => {
    let sawAbort = false;
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const world = makeWorld({ chat: lateResponder() });
    late = {
      async *respond(_i, signal) {
        yield sampleSSEAutoAnswer[0]!;
        yield { type: 'sources', sources: [] };
        yield { type: 'token', text: '부분 답변입니다. ' };
        release();
        await new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve(), { once: true }));
        sawAbort = signal.aborted;
        yield { type: 'token', text: '끊긴 뒤 조각' };
      },
    };
    const c = await loginAs(world, 'custA1');
    const ctrl = new AbortController();
    const res = await world.app.handle(
      new Request(`${ORIGIN}/api/t/game/chat`, {
        method: 'POST',
        headers: {
          origin: ORIGIN,
          'content-type': 'application/json',
          cookie: [...c.cookies].map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('; '),
          'x-csrf-token': c.csrf!,
        },
        body: JSON.stringify({ body: '최소 사양?' }),
        signal: ctrl.signal,
      }),
    );
    const reader = res.body!.getReader();
    await reader.read();
    await gate;
    ctrl.abort();
    await reader.cancel();
    await new Promise((r) => setTimeout(r, 10));
    expect(sawAbort).toBe(true);
    const convs = world.repo.state.conversationMessages;
    expect(convs.map((m) => m.role)).toEqual(['user']);
    expect(JSON.stringify(convs)).not.toContain('부분 답변');
  });

  it('남의 대화는 404, 다른 고객이 conversationId를 넣어도 이어 쓸 수 없다', async () => {
    const w = makeWorld();
    const a = await loginAs(w, 'custA1');
    const id = parseSse((await a.post('/t/game/chat', { body: 'hi' })).text).at(-1)!.data.conversationId;
    const b = await loginAs(w, 'custA2');
    expect((await b.get(`/t/game/conversations/${id}`)).status).toBe(404);
    expect((await b.post('/t/game/chat', { conversationId: id, body: 'hijack' })).status).toBe(404);
    expect((await b.post(`/t/game/conversations/${id}/convert`, { title: 'x' })).status).toBe(404);
    const other = await loginAs(w, 'custB1');
    expect((await other.get(`/t/mkt/conversations/${id}`)).status).toBe(404);
  });
});

describe('SSE 결과 저장·초안 승계·공개 근거', () => {
  it('자동답변: assistant 근거는 공개 필드만 저장, ai_runs에는 작업 없는 실행+마스킹 원본, 초안 없음', async () => {
    const world = makeWorld({ chat: lateResponder() });
    late = replay(world, sampleSSEAutoAnswer);
    const c = await loginAs(world, 'custA1');
    const done = parseSse((await c.post('/t/game/chat', { body: '최소 사양?' })).text).at(-1)!.data;
    const saved = world.repo.state.conversationMessages.find((m) => m.id === done.messageId)!;
    expect(saved.sources!.map((s) => Object.keys(s).sort())).toEqual([['excerpt', 'id', 'title']]);
    expect(JSON.stringify(saved)).not.toContain('score');
    const conv = (await c.get(`/t/game/conversations/${done.conversationId}`)).json;
    const last = conv.messages.at(-1);
    expect(Object.keys(last.sources[0]).sort()).toEqual(['excerpt', 'id', 'title']);
    expect(last).not.toHaveProperty('escalationReason');
    expect(last).not.toHaveProperty('noticeCode');

    expect(world.repo.state.runs).toHaveLength(1);
    expect(world.repo.state.runs[0]).toMatchObject({ jobId: null, ticketId: null, conversationId: done.conversationId, decision: 'auto_answer', status: 'succeeded' });
    // 원본은 워커와 같은 위치 result.aiResult(최상위에 원본 키 없음)
    expect(world.repo.state.runs[0]!.result).toMatchObject({ aiResult: { reason: 'confident_kb_match', decision: 'auto_answer' } });
    expect(world.repo.state.runs[0]!.result).not.toHaveProperty('draft');
    expect(world.repo.state.drafts).toHaveLength(0);
  });

  it('이관: system 안내에 escalationReason·noticeCode 복원, 초안은 대화 출처로 보존되고 고객 응답에 없다', async () => {
    const world = makeWorld({ chat: lateResponder() });
    late = replay(world, sampleSSEEscalated);
    const c = await loginAs(world, 'custA1');
    const res = await c.post('/t/game/chat', { body: '환불' });
    const done = parseSse(res.text).at(-1)!.data;
    const conv = (await c.get(`/t/game/conversations/${done.conversationId}`)).json;
    const sys = conv.messages.at(-1);
    expect(sys).toMatchObject({ role: 'system', escalationReason: 'forbidden_category', noticeCode: 'ESCALATED' });
    expect(conv.messages[0]).not.toHaveProperty('escalationReason');

    const [draft] = world.repo.state.drafts;
    expect(draft).toMatchObject({ conversationId: done.conversationId, ticketId: null, jobId: null, runId: world.repo.state.runs[0]!.id, status: 'draft' });
    const draftBody = draft!.body;
    expect(res.text).not.toContain(draftBody.slice(0, 20));
    expect(JSON.stringify(conv)).not.toContain(draftBody.slice(0, 20));
  });

  it('대화당 초안 1개: 전환 전 후속 이관 결과는 같은 초안을 갱신(version+1)', async () => {
    const world = makeWorld({ chat: lateResponder() });
    late = replay(world, sampleSSEEscalated);
    const c = await loginAs(world, 'custA1');
    const id = parseSse((await c.post('/t/game/chat', { body: '환불' })).text).at(-1)!.data.conversationId;
    await c.post('/t/game/chat', { conversationId: id, body: '환불 다시 문의' });
    expect(world.repo.state.drafts).toHaveLength(1);
    expect(world.repo.state.drafts[0]).toMatchObject({ version: 2, runId: world.repo.state.runs[1]!.id });
    expect(world.repo.state.runs).toHaveLength(2);
  });

  it('고객 클릭 전환: 같은 초안 행에 ticketId만 추가(conversationId 출처 유지), 이관 사유 복원, 승인 발송 근거는 공개 필드만', async () => {
    const world = makeWorld({ chat: lateResponder() });
    late = replay(world, approvalEvents.slice(0, 1).concat(sampleSSEEscalated.slice(1, 2), [{ type: 'done', result: { ...sampleRunPendingApproval, decision: 'escalate', reason: 'forbidden_category', ticketId: undefined } }]));
    const c = await loginAs(world, 'custA1');
    const id = parseSse((await c.post('/t/game/chat', { body: '환불' })).text).at(-1)!.data.conversationId;
    const draftId = world.repo.state.drafts[0]!.id;
    const conv = await c.post(`/t/game/conversations/${id}/convert`, { title: '환불 요청' });
    expect(conv.status).toBe(201);
    const ticketId = conv.json.ticketId;
    expect(world.repo.state.drafts).toHaveLength(1);
    expect(world.repo.state.drafts[0]).toMatchObject({ id: draftId, ticketId, conversationId: id, version: 1 });
    expect(world.repo.state.tickets[0]).toMatchObject({ escalationReason: 'forbidden_category' });
    expect(world.repo.state.jobs).toHaveLength(0);

    const agent = await loginAs(world, 'agentA');
    const detail = (await agent.get(`/t/game/admin/tickets/${ticketId}`)).json;
    expect(detail.drafts).toEqual([expect.objectContaining({ id: draftId, conversationId: id, jobId: null })]);
    expect(detail.aiRuns).toEqual([expect.objectContaining({ conversationId: id, reason: 'forbidden_category' })]);
    expect(detail.aiRuns[0].result.aiResult).toMatchObject({ decision: 'escalate', draft: expect.objectContaining({ customerVisible: false }) });

    const approved = await agent.post(`/t/game/admin/tickets/${ticketId}/drafts/${draftId}/approve`, { version: 1 });
    expect(approved.status).toBe(200);
    const sent = world.repo.state.ticketMessages.find((m) => m.draftId === draftId)!;
    expect(sent.sources!.length).toBeGreaterThan(0);
    for (const s of sent.sources!) expect(Object.keys(s).sort()).toEqual(['excerpt', 'id', 'title']);
    const customer = (await c.get(`/t/game/tickets/${ticketId}`)).json;
    const pub = customer.messages.find((m: { body: string }) => m.body === sent.body);
    expect(Object.keys(pub.sources[0]).sort()).toEqual(['excerpt', 'id', 'title']);
    expect(JSON.stringify(customer)).not.toContain('score');
    // aiResult 통일 후에도 고객 응답(티켓·대화)에는 AI 실행 결과가 전혀 없다
    expect(JSON.stringify(customer)).not.toContain('aiResult');
    const convView = (await c.get(`/t/game/conversations/${id}`)).text;
    for (const k of ['aiResult', 'confidence', 'reasonDetail', 'draft']) expect(convView).not.toContain(`"${k}"`);
    expect(JSON.stringify(customer)).not.toContain(world.tenantA.id);
  });

  it('승인 모드 자동 전환: 초안이 전환 티켓에 바로 승계된다', async () => {
    const world = makeWorld({ chat: lateResponder() });
    late = replay(world, approvalEvents);
    world.repo.state.settings.find((s) => s.tenantId === world.tenantA.id)!.approvalMode = true;
    const c = await loginAs(world, 'custA1');
    const done = parseSse((await c.post('/t/game/chat', { body: '최소 사양?' })).text).at(-1)!.data;
    expect(world.repo.state.drafts).toHaveLength(1);
    expect(world.repo.state.drafts[0]).toMatchObject({ ticketId: done.ticketId, conversationId: done.conversationId, status: 'draft' });
    const conv = (await c.get(`/t/game/conversations/${done.conversationId}`)).json;
    expect(conv.messages.at(-1)).toMatchObject({ role: 'system', escalationReason: 'approval_mode', noticeCode: 'APPROVAL_REQUIRED' });
  });
});

describe('대화 → 티켓 전환(고객 클릭)', () => {
  it('동시 전환 요청에도 티켓 1건·같은 ticketId, 이관 기록, ai_jobs 없음(워커 재처리 없음)', async () => {
    const w = makeWorld();
    const c = await loginAs(w, 'custA1');
    const id = parseSse((await c.post('/t/game/chat', { body: '계정이 해킹당했어요' })).text).at(-1)!.data.conversationId;
    const [r1, r2] = await Promise.all([
      c.post(`/t/game/conversations/${id}/convert`, { title: '계정 해킹' }),
      c.post(`/t/game/conversations/${id}/convert`, { title: '계정 해킹' }),
    ]);
    expect([r1.status, r2.status].sort()).toEqual([200, 201]);
    expect(r1.json.ticketId).toBe(r2.json.ticketId);
    expect(w.repo.state.tickets).toHaveLength(1);
    expect(w.repo.state.tickets[0]).toMatchObject({ conversationId: id, title: '계정 해킹', status: 'open' });
    expect(w.repo.state.tickets[0]!.escalatedAt).not.toBeNull();
    expect(w.repo.state.jobs).toHaveLength(0);
    const t = await c.get(`/t/game/tickets/${r1.json.ticketId}`);
    expect(t.json.messages[0].body).toContain('계정이 해킹당했어요');
    expect((await c.post('/t/game/chat', { conversationId: id, body: '더' })).status).toBe(409);
    expect((await c.get(`/t/game/conversations/${id}`)).json).toMatchObject({ status: 'converted', ticketId: r1.json.ticketId });
  });

  it('POST /tickets {conversationId}도 같은 전환 경로를 탄다(중복 없음)', async () => {
    const w = makeWorld();
    const c = await loginAs(w, 'custA1');
    const id = parseSse((await c.post('/t/game/chat', { body: '버그 제보' })).text).at(-1)!.data.conversationId;
    const a = await c.post(`/t/game/conversations/${id}/convert`, { title: '버그' });
    const b = await c.post('/t/game/tickets', { title: '버그', body: '버그 제보', conversationId: id });
    expect(a.status).toBe(201);
    expect(b.status).toBe(200);
    expect(b.json.id).toBe(a.json.ticketId);
    expect(w.repo.state.tickets).toHaveLength(1);
  });
});
