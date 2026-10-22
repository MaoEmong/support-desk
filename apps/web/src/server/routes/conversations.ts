import { randomUUID } from 'node:crypto';
import { maskDeep, type AIRunResult, type DecisionReason } from '@support/ai';
import { formatPublicSSE } from '@support/contracts';
import { noticeCodeFor, PROCESSING_FAILED_MESSAGE, PublicSseMapper, type PublicSseEvent } from '../ai/sse-public';
import { toConversation } from '../dto';
import type { Actor, Conversation, ConversationMessage, PublicSource, Ticket } from '../domain';
import { ApiError } from '../errors';
import { readBody, requireActor, type Ctx } from '../http/context';
import type { Router } from '../http/router';
import { assertCan } from '../policy';
import type { SourcePolicy } from '../public-sources';
import type { Repo } from '../repo/types';
import { chatBody, convertBody, idParam } from '../validation';
import { customerMessage } from './customer';

/** 챗봇 대화(고객 전용). 메시지 전송은 SSE(text/event-stream)로 응답한다. 대화는 SSE만 처리하고 워커 작업을 만들지 않는다. */
export function registerConversationRoutes(r: Router) {
  // 계약 ChatInput {conversationId?, body}: conversationId가 없으면 새 대화를 만든다.
  r.add({
    method: 'POST',
    pattern: '/t/:slug/chat',
    auth: 'tenant',
    handler: async (ctx) => {
      const actor = requireActor(ctx);
      assertCan(actor, 'conversation:use');
      const body = await readBody(ctx, chatBody);
      const { repo } = ctx.deps;
      const tenantId = actor.tenantId!;
      const settings = await repo.getSettings(tenantId);
      if (!settings) throw new ApiError('NOT_FOUND');
      const { conv, userMsg } = await repo.tx(async (tx) => {
        const conv = body.conversationId
          ? await ownConversation(tx, actor, body.conversationId)
          : await tx.createConversation({ id: randomUUID(), tenantId, customerId: actor.userId, status: 'open', ticketId: null }, ctx.now);
        if (conv.status !== 'open') {
          throw new ApiError('CONFLICT', '이미 문의글로 전환되었거나 종료된 대화입니다.', { status: conv.status, ticketId: conv.ticketId });
        }
        const userMsg = await tx.addConversationMessage(
          { id: randomUUID(), tenantId, conversationId: conv.id, role: 'user', body: body.body, sources: null, reason: null, noticeCode: null },
          ctx.now,
        );
        return { conv, userMsg };
      });
      return sseResponse(ctx, actor, conv, userMsg.id, { approvalMode: settings.approvalMode, policy: { tenantId, allowedLinkDomains: settings.allowedLinkDomains } });
    },
  });

  r.add({
    method: 'GET',
    pattern: '/t/:slug/conversations/:id',
    auth: 'tenant',
    handler: async (ctx) => {
      const actor = requireActor(ctx);
      assertCan(actor, 'conversation:use');
      const c = await ownConversation(ctx.deps.repo, actor, idParam(ctx, 'id'));
      const settings = await ctx.deps.repo.getSettings(c.tenantId);
      const policy = { tenantId: c.tenantId, allowedLinkDomains: settings?.allowedLinkDomains ?? [] };
      return toConversation(c, await ctx.deps.repo.listConversationMessages(c.tenantId, c.id), policy);
    },
  });

  // "문의글로 남기기"(고객 클릭): 대화 → 티켓 전환(대화당 1건, 동시 요청에도 1건)
  r.add({
    method: 'POST',
    pattern: '/t/:slug/conversations/:id/convert',
    auth: 'tenant',
    handler: async (ctx) => {
      const actor = requireActor(ctx);
      const id = idParam(ctx, 'id');
      const body = await readBody(ctx, convertBody);
      const result = await convertConversation(ctx, actor, id, body.title);
      return Response.json(result, { status: result.created ? 201 : 200 });
    },
  });
}

/** 고객 클릭 전환(별도 트랜잭션). POST /tickets {conversationId}도 이 경로를 탄다. */
export async function convertConversation(ctx: Ctx, actor: Actor, conversationId: string, title?: string) {
  assertCan(actor, 'ticket:create');
  return ctx.deps.repo.tx(async (tx) => convertInTx(ctx, tx, actor, await ownConversation(tx, actor, conversationId), { title }));
}

/**
 * 대화 → 티켓 전환(호출자 트랜잭션 안).
 * - open→converted 조건부 갱신에 성공한 요청만 티켓을 만들고, tickets.conversation_id UNIQUE가 마지막 방어선. 이미 전환됐으면 기존 티켓.
 * - 전환 티켓은 상담원 처리 대상: escalatedAt/escalationReason을 같은 tx에서 기록하고 status는 open 유지.
 * - ai_jobs를 만들지 않는다(대화에서 이미 AI 판단을 거쳤고, 워커가 다시 자동답변하면 안 된다).
 */
async function convertInTx(
  ctx: Ctx,
  tx: Repo,
  actor: Actor,
  conv: Conversation,
  opts: { title?: string; reason?: DecisionReason },
): Promise<{ ticketId: string; created: boolean }> {
  const tenantId = conv.tenantId;
  const existing = await tx.findTicketByConversation(tenantId, conv.id);
  if (existing) return { ticketId: existing.id, created: false };
  const claimed = await tx.updateConversationIfStatus(tenantId, conv.id, 'open', { status: 'converted' }, ctx.now);
  if (!claimed) {
    const t = await tx.findTicketByConversation(tenantId, conv.id);
    if (t) return { ticketId: t.id, created: false };
    throw new ApiError('CONFLICT', '전환할 수 없는 대화입니다.', { status: conv.status });
  }
  const messages = await tx.listConversationMessages(tenantId, conv.id);
  const firstUser = messages.find((m) => m.role === 'user');
  if (!firstUser) throw new ApiError('VALIDATION_FAILED', '대화 내용이 없습니다.');
  const settings = await tx.getSettings(tenantId);
  const ticketTitle = opts.title ?? (firstUser.body.length > 50 ? `${firstUser.body.slice(0, 50)}…` : firstUser.body);
  const created = await tx.createTicket(
    { id: randomUUID(), tenantId, customerId: conv.customerId, title: ticketTitle, body: firstUser.body, conversationId: conv.id, idempotencyKey: null },
    ctx.now,
  );
  await tx.addTicketMessage(customerMessage(created, actor, transcript(messages, settings?.chatbotName ?? '챗봇')), ctx.now);
  // 이관 사유: 자동 전환은 이번 결과, 고객 클릭 전환은 대화의 마지막 system 안내에 저장된 사유
  const reason = opts.reason ?? [...messages].reverse().find((m) => m.role === 'system' && m.reason)?.reason ?? null;
  const ticket: Ticket | null = await tx.updateTicket(tenantId, created.id, { escalatedAt: ctx.now, escalationReason: reason }, ctx.now);
  // SSE 결과 초안 승계: 같은 행에 ticketId만 추가(conversationId 출처 유지, 재생성 없음)
  await tx.attachConversationDrafts(tenantId, conv.id, created.id, ctx.now);
  await tx.updateConversationIfStatus(tenantId, conv.id, 'converted', { ticketId: created.id }, ctx.now);
  await tx.audit(
    {
      tenantId,
      actorId: actor.userId,
      action: 'conversation.convert',
      targetType: 'conversation',
      targetId: conv.id,
      meta: { ticketId: created.id, auto: opts.reason !== undefined },
    },
    ctx.now,
  );
  return { ticketId: (ticket ?? created).id, created: true };
}

async function ownConversation(repo: Repo, actor: Actor, id: string): Promise<Conversation> {
  const c = await repo.getConversation(actor.tenantId!, id);
  if (!c || c.customerId !== actor.userId) throw new ApiError('NOT_FOUND');
  return c;
}

function transcript(messages: ConversationMessage[], botName: string) {
  const lines = messages.map((m) => `${m.role === 'user' ? '고객' : m.role === 'assistant' ? botName : '안내'}: ${m.body}`);
  const text = `[챗봇 상담 내용]\n${lines.join('\n')}`;
  return text.length > 20_000 ? `${text.slice(0, 19_990)}\n…(생략)` : text;
}

// ---------- SSE ----------
const encoder = new TextEncoder();
/** 공개 DTO만 contracts formatPublicSSE로 직렬화(스키마 검증 포함). 내부 이벤트·AI formatSSE는 쓰지 않는다 */
function frame(ev: PublicSseEvent): Uint8Array | null {
  try {
    return encoder.encode(formatPublicSSE(ev));
  } catch {
    console.error('[chat] public SSE schema violation', ev.event);
    return null;
  }
}
const HEARTBEAT = encoder.encode(': keep-alive\n\n');

/**
 * 순서: classified → (sources → token*) | escalated | error → done{conversationId, messageId?, ticketId?}
 * - 고객 연결이 끊기면(req.signal·stream cancel) 응답기에 abort를 전파하고 아무것도 저장하지 않는다(부분 답변 미저장).
 * - 내부 done.result를 받은 뒤에만 저장한다. 공개 done은 저장된 IDs만.
 * - 승인 모드(pending_approval)는 안내 후 같은 tx에서 티켓으로 자동 전환(멱등) → done.ticketId.
 */
function sseResponse(
  ctx: Ctx,
  actor: Actor,
  conv: Conversation,
  messageId: string,
  opts: { approvalMode: boolean; policy: SourcePolicy },
): Response {
  const { chat, cfg } = ctx.deps;
  const abort = new AbortController();
  const onClientAbort = () => abort.abort();
  ctx.req.signal?.addEventListener('abort', onClientAbort, { once: true });
  const conversationId = conv.id;

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let closed = false;
      const write = (chunk: Uint8Array) => {
        if (closed || abort.signal.aborted) return;
        try {
          controller.enqueue(chunk);
        } catch {
          closed = true;
        }
      };
      const send = (ev: PublicSseEvent | null) => {
        const chunk = ev && frame(ev);
        if (chunk) write(chunk);
      };
      const heartbeat = setInterval(() => write(HEARTBEAT), cfg.sseHeartbeatMs);
      const mapper = new PublicSseMapper({ policy: opts.policy, conversationId, approvalMode: opts.approvalMode });
      let result: AIRunResult | null = null;
      try {
        for await (const ev of chat.respond({ tenantId: conv.tenantId, conversationId, messageId }, abort.signal)) {
          if (abort.signal.aborted) break;
          if (ev.type === 'done') {
            result = ev.result;
            break;
          }
          send(mapper.map(ev));
        }
      } catch (e) {
        if (!abort.signal.aborted) {
          console.error('[chat] responder failed', e instanceof Error ? e.name : 'unknown');
          send(mapper.map({ type: 'error', code: 'INTERNAL', message: '' }));
        }
      }
      clearInterval(heartbeat);
      if (abort.signal.aborted) {
        ctx.req.signal?.removeEventListener('abort', onClientAbort);
        if (!closed) controller.close();
        return;
      }
      if (!result && !mapper.failed && !mapper.escalation) send(mapper.map({ type: 'error', code: 'INTERNAL', message: '' }));

      let saved: { messageId?: string; ticketId?: string } = {};
      try {
        saved = await persist(ctx, actor, conv, mapper, result, abort.signal);
      } catch (e) {
        if (!(e instanceof PersistAborted)) console.error('[chat] persist failed', e instanceof Error ? e.name : 'unknown');
      }
      // 커밋 전에 끊겼으면 롤백되어 질문만 남는다. 커밋 후 끊김은 저장 유지(삭제하지 않음), done은 닫힌 연결에 쓰지 않는다.
      send({ event: 'done', data: { conversationId, ...saved } });
      ctx.req.signal?.removeEventListener('abort', onClientAbort);
      if (!closed) controller.close();
    },
    cancel() {
      abort.abort();
    },
  });
  return new Response(stream, {
    status: 200,
    headers: {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      'x-accel-buffering': 'no',
      connection: 'keep-alive',
    },
  });
}

/**
 * done 이후에만, 한 트랜잭션으로 저장한다.
 * - ai_runs: 작업 없는 SSE 실행(jobId null, conversationId·messageId). 원본 결과는 maskDeep 후 result에만.
 * - 고객 메시지: 실제로 내보낸 것만. 자동답변은 token 텍스트 + 공개 근거(소속 검증 후 공개 필드만),
 *   이관·오류는 안내 문구 + reason·noticeCode(system).
 * - ai_drafts: 자동답변이 아닌 결과의 초안(상담원 전용, 고객 비노출)을 대화당 1개로 보존 → 전환 시 티켓에 승계.
 * - 승인 모드(pending_approval): 같은 tx에서 티켓 자동 전환(멱등).
 */
/** 커밋 전 연결 끊김으로 저장 트랜잭션을 롤백할 때 */
class PersistAborted extends Error {}

async function persist(
  ctx: Ctx,
  actor: Actor,
  conv: Conversation,
  mapper: PublicSseMapper,
  result: AIRunResult | null,
  signal: AbortSignal,
): Promise<{ messageId?: string; ticketId?: string }> {
  const now = ctx.deps.clock();
  const answered = result?.decision === 'auto_answer' && mapper.answer.length > 0 && !mapper.escalation && !mapper.failed;
  return ctx.deps.repo.tx(async (tx) => {
    // 고객에게 보낸 근거 그대로 저장(매퍼가 공개 정책 toPublicSources를 이미 적용: {id,title,excerpt?,url?})
    const sources: PublicSource[] = mapper.sources;
    if (result) {
      const run = await tx.createRun(
        {
          id: randomUUID(),
          tenantId: conv.tenantId,
          jobId: null,
          ticketId: null,
          conversationId: conv.id,
          messageId: result.messageId,
          status: result.error ? 'failed' : 'succeeded',
          decision: result.decision,
          reason: result.reason,
          category: result.classification?.category ?? null,
          urgency: result.classification?.urgency ?? null,
          sentiment: result.classification?.sentiment ?? null,
          confidence: result.confidence.final,
          sources: maskDeep(result.sources),
          model: result.draft?.model ?? result.usage.at(-1)?.model ?? null,
          inputTokens: result.usage.reduce((s, u) => s + u.inputTokens, 0),
          outputTokens: result.usage.reduce((s, u) => s + u.outputTokens, 0),
          latencyMs: Math.round(result.timing.totalMs),
          error: result.error?.code ?? null,
          pipelineVersion: result.pipelineVersion,
          // 원본은 워커와 같은 위치(ai_runs.result.aiResult). 평탄 분석값은 위 컬럼들
          result: { aiResult: maskDeep(result) },
        },
        now,
      );
      if (result.draft && !answered) {
        await tx.saveConversationDraft(
          { id: randomUUID(), tenantId: conv.tenantId, conversationId: conv.id, runId: run.id, body: result.draft.body, sources: maskDeep(result.draft.sources) },
          now,
        );
      }
    }
    const msg = await tx.addConversationMessage(
      answered
        ? { id: randomUUID(), tenantId: conv.tenantId, conversationId: conv.id, role: 'assistant', body: mapper.answer, sources, reason: null, noticeCode: null }
        : {
            id: randomUUID(),
            tenantId: conv.tenantId,
            conversationId: conv.id,
            role: 'system',
            body: mapper.escalation?.message ?? PROCESSING_FAILED_MESSAGE,
            sources: null,
            reason: mapper.escalation?.reason ?? result?.reason ?? 'ai_error',
            noticeCode: noticeCodeFor(mapper.escalation ? (result?.decision === 'pending_approval' ? 'pending_approval' : 'escalate') : 'error'),
          },
      now,
    );
    let ticketId: string | undefined;
    if (result?.decision === 'pending_approval' && mapper.escalation) {
      const current = await tx.getConversation(conv.tenantId, conv.id);
      if (current) ticketId = (await convertInTx({ ...ctx, now }, tx, actor, current, { reason: mapper.escalation.reason })).ticketId;
    }
    // 커밋 직전 경계: 이미 끊겼으면 롤백(질문만 남음). 이 지점 이후의 끊김은 커밋된 결과를 보존한다.
    if (signal.aborted) throw new PersistAborted();
    return ticketId ? { messageId: msg.id, ticketId } : { messageId: msg.id };
  });
}
