import { randomUUID } from 'node:crypto';
import { toCustomerTicket, toCustomerTicketDetail } from '../dto';
import type { Actor, Ticket, TicketMessage } from '../domain';
import { ApiError } from '../errors';
import { readBody, readQuery, requireActor, type Ctx } from '../http/context';
import type { Router } from '../http/router';
import { assertCan, assertOwnTicket } from '../policy';
import { isUniqueViolation, type NewTicket, type Repo, type TicketPatch } from '../repo/types';
import { createTicketBody, idempotencyKeyHeader, idParam, messageBody, pageQuery } from '../validation';
import { convertConversation } from './conversations';
import { nameBook } from './shared';

/**
 * 고객 API. 모든 조회는 (tenantId, customerId=본인)으로 범위를 좁힌다.
 * 남의 티켓·다른 테넌트 티켓은 404. 응답은 고객 DTO(내부 메모·초안·AI 분석 제외)만.
 */
export function registerCustomerRoutes(r: Router) {
  r.add({
    method: 'GET',
    pattern: '/t/:slug/tickets',
    auth: 'tenant',
    handler: async (ctx) => {
      const actor = requireActor(ctx);
      assertCan(actor, 'ticket:read_own');
      const q = readQuery(ctx, pageQuery);
      const tenantId = actor.tenantId!;
      const page = await ctx.deps.repo.listTickets(tenantId, { customerId: actor.userId }, { page: q.page, pageSize: Math.min(q.pageSize, 50) });
      const items = [];
      for (const t of page.items) {
        // TODO(성능): 표시 상태 계산용 N+1(페이지 최대 50). 필요 시 마지막 공개 작성자 컬럼으로 대체.
        const msgs = await ctx.deps.repo.listTicketMessages(tenantId, t.id);
        items.push(toCustomerTicket(t, msgs.filter((m) => m.visibility === 'public')));
      }
      return { ...page, items };
    },
  });

  r.add({
    method: 'POST',
    pattern: '/t/:slug/tickets',
    auth: 'tenant',
    handler: async (ctx) => {
      const actor = requireActor(ctx);
      assertCan(actor, 'ticket:create');
      const body = await readBody(ctx, createTicketBody);
      // 챗봇 대화에서 넘어온 문의는 대화 전환 경로(대화당 1건)로 처리
      if (body.conversationId) {
        const res = await convertConversation(ctx, actor, body.conversationId, body.title);
        const t = await ctx.deps.repo.getTicket(actor.tenantId!, res.ticketId);
        return Response.json(await customerDetail(ctx, actor, t!), { status: res.created ? 201 : 200 });
      }
      const key = idempotencyKeyHeader(ctx);
      const tenantId = actor.tenantId!;
      const run = () =>
        ctx.deps.repo.tx(async (tx) => {
          if (key) {
            const existing = await tx.findTicketByIdempotencyKey(tenantId, actor.userId, key);
            if (existing) return { ticket: existing, created: false };
          }
          const ticket = await createTicketWithMessage(ctx, tx, actor, {
            id: randomUUID(),
            tenantId,
            customerId: actor.userId,
            title: body.title,
            body: body.body,
            conversationId: null,
            idempotencyKey: key,
          });
          return { ticket, created: true };
        });
      let result: { ticket: Ticket; created: boolean };
      try {
        result = await run();
      } catch (e) {
        // 같은 키로 동시에 들어온 재시도: 유니크 제약에 걸린 쪽은 먼저 만든 티켓을 돌려준다
        if (!key || !isUniqueViolation(e)) throw e;
        const existing = await ctx.deps.repo.findTicketByIdempotencyKey(tenantId, actor.userId, key);
        if (!existing) throw e;
        result = { ticket: existing, created: false };
      }
      return Response.json(await customerDetail(ctx, actor, result.ticket), { status: result.created ? 201 : 200 });
    },
  });

  r.add({
    method: 'GET',
    pattern: '/t/:slug/tickets/:id',
    auth: 'tenant',
    handler: async (ctx) => {
      const actor = requireActor(ctx);
      assertCan(actor, 'ticket:read_own');
      const ticket = await ctx.deps.repo.getTicket(actor.tenantId!, idParam(ctx, 'id'));
      assertOwnTicket(actor, ticket);
      return customerDetail(ctx, actor, ticket);
    },
  });

  // 댓글(재문의 포함). resolved 상태에서 댓글을 달면 open으로 되돌린다.
  r.add({
    method: 'POST',
    pattern: '/t/:slug/tickets/:id/messages',
    auth: 'tenant',
    handler: async (ctx) => {
      const actor = requireActor(ctx);
      assertCan(actor, 'ticket:comment_own');
      const id = idParam(ctx, 'id');
      const body = await readBody(ctx, messageBody);
      const tenantId = actor.tenantId!;
      const { repo, queue } = ctx.deps;

      const ticket = await repo.tx(async (tx) => {
        const t = await tx.lockTicket(tenantId, id);
        assertOwnTicket(actor, t);
        if (t.status === 'closed') throw new ApiError('TICKET_CLOSED');
        const msg = await tx.addTicketMessage(customerMessage(t, actor, body.body), ctx.now);
        const patch: TicketPatch = {};
        if (t.status === 'resolved') Object.assign(patch, { status: 'open', resolvedAt: null, resolvedByCustomer: false });
        if (t.autoReplyCount > 0 || t.autoAnsweredAt) {
          // 자동답변은 티켓당 1회. 이후 고객 댓글은 상담원에게 넘긴다(AI 재실행 없음).
          if (!t.escalatedAt) Object.assign(patch, { escalatedAt: ctx.now, escalationReason: 'customer_followup_after_auto_answer' });
        } else if (!t.escalatedAt) {
          await queue.enqueueInquiry(tx, { tenantId, ticketId: t.id, messageId: msg.id }, ctx.now);
        }
        return (await tx.updateTicket(tenantId, t.id, patch, ctx.now))!;
      });
      return Response.json(await customerDetail(ctx, actor, ticket), { status: 201 });
    },
  });

  // 고객 해결 확인(자동해결률 산정 기준)
  r.add({
    method: 'POST',
    pattern: '/t/:slug/tickets/:id/resolve',
    auth: 'tenant',
    handler: async (ctx) => {
      const actor = requireActor(ctx);
      assertCan(actor, 'ticket:confirm_resolved');
      const id = idParam(ctx, 'id');
      const tenantId = actor.tenantId!;
      const ticket = await ctx.deps.repo.tx(async (tx) => {
        const t = await tx.lockTicket(tenantId, id);
        assertOwnTicket(actor, t);
        if (t.status === 'resolved' && t.resolvedByCustomer) return t; // 멱등
        if (t.status === 'closed') throw new ApiError('INVALID_TRANSITION', undefined, { from: t.status, to: 'resolved' });
        await tx.audit({ tenantId, actorId: actor.userId, action: 'ticket.confirm_resolved', targetType: 'ticket', targetId: t.id }, ctx.now);
        return (await tx.updateTicket(tenantId, t.id, { status: 'resolved', resolvedAt: ctx.now, resolvedByCustomer: true }, ctx.now))!;
      });
      return customerDetail(ctx, actor, ticket);
    },
  });
}

export function customerMessage(t: Pick<Ticket, 'id' | 'tenantId'>, actor: Actor, body: string): Omit<TicketMessage, 'createdAt'> {
  return {
    id: randomUUID(),
    tenantId: t.tenantId,
    ticketId: t.id,
    authorId: actor.userId,
    role: 'customer',
    authorType: 'customer',
    visibility: 'public',
    body,
    sources: null,
    draftId: null,
    sourceJobId: null,
  };
}

/** 티켓 + 첫 고객 메시지 + AI 작업을 호출자 트랜잭션(tx) 안에서 함께 만든다(유실 없음). */
export async function createTicketWithMessage(ctx: Ctx, tx: Repo, actor: Actor, input: NewTicket, firstMessage = input.body) {
  const ticket = await tx.createTicket(input, ctx.now);
  const msg = await tx.addTicketMessage(customerMessage(ticket, actor, firstMessage), ctx.now);
  await ctx.deps.queue.enqueueInquiry(tx, { tenantId: ticket.tenantId, ticketId: ticket.id, messageId: msg.id }, ctx.now);
  await tx.audit({ tenantId: ticket.tenantId, actorId: actor.userId, action: 'ticket.create', targetType: 'ticket', targetId: ticket.id }, ctx.now);
  return ticket;
}

async function customerDetail(ctx: Ctx, actor: Actor, ticket: Ticket) {
  const { repo } = ctx.deps;
  const tenantId = actor.tenantId!;
  // public만 먼저 거른 뒤 DTO 구성(계약 요구: 스키마 필드 제거만으로 내부 행을 숨기지 않는다)
  const pub = (await repo.listTicketMessages(tenantId, ticket.id)).filter((m) => m.visibility === 'public');
  const names = await nameBook(repo, tenantId, pub.map((m) => m.authorId));
  return toCustomerTicketDetail(ticket, pub, names);
}
