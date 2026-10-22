import { randomUUID } from 'node:crypto';
import { toDraft, toStaffTicket, toStaffTicketDetail } from '../dto';
import { toPublicSources } from '../public-sources';
import type { Actor, AiDraft, Ticket, TicketStatus } from '../domain';
import { ApiError } from '../errors';
import { readBody, readQuery, requireActor, type Ctx } from '../http/context';
import type { Router } from '../http/router';
import { assertCan, assertStaffTransition, assertTenantTicket, isStaff } from '../policy';
import type { Repo, TicketFilter, TicketPatch } from '../repo/types';
import {
  approveDraftBody,
  editDraftBody,
  idempotencyKeyHeader,
  idParam,
  messageBody,
  queueQuery,
  rejectDraftBody,
  staffMessageBody,
  updateTicketBody,
} from '../validation';
import { nameBook } from './shared';

/** 상담원·테넌트 관리자 API. 범위는 세션 테넌트 전체(고객 소유 제한 없음). 다른 테넌트 id는 404. */
export function registerStaffRoutes(r: Router) {
  r.add({
    method: 'GET',
    pattern: '/t/:slug/admin/tickets',
    auth: 'tenant',
    handler: async (ctx) => {
      const actor = requireActor(ctx);
      assertCan(actor, 'queue:read');
      const q = readQuery(ctx, queueQuery);
      const filter: TicketFilter = {
        status: q.status,
        category: q.category,
        urgency: q.urgency,
        sentiment: q.sentiment,
        assigneeId: q.assigneeId === 'me' ? actor.userId : q.assigneeId,
        escalated: q.escalated === undefined ? undefined : q.escalated === 'true',
      };
      const tenantId = actor.tenantId!;
      const page = await ctx.deps.repo.listTickets(tenantId, filter, { page: q.page, pageSize: q.pageSize });
      const names = await nameBook(ctx.deps.repo, tenantId, page.items.flatMap((t) => [t.customerId, t.assigneeId]));
      return { ...page, items: page.items.map((t) => toStaffTicket(t, names)) };
    },
  });

  r.add({
    method: 'GET',
    pattern: '/t/:slug/admin/tickets/:id',
    auth: 'tenant',
    handler: async (ctx) => {
      const actor = requireActor(ctx);
      assertCan(actor, 'queue:read');
      const t = await ctx.deps.repo.getTicket(actor.tenantId!, idParam(ctx, 'id'));
      assertTenantTicket(actor, t);
      return staffDetail(ctx.deps.repo, t);
    },
  });

  // 상태·배정 변경: 계약 UpdateTicketInput {version, status?, assigneeId?}. version 불일치 409.
  r.add({
    method: 'PATCH',
    pattern: '/t/:slug/admin/tickets/:id',
    auth: 'tenant',
    handler: async (ctx) => {
      const actor = requireActor(ctx);
      const id = idParam(ctx, 'id');
      const body = await readBody(ctx, updateTicketBody);
      if (body.status !== undefined) assertCan(actor, 'ticket:set_status');
      if (body.assigneeId !== undefined) assertCan(actor, 'ticket:assign');
      if (body.status === undefined && body.assigneeId === undefined) assertCan(actor, 'queue:read');
      const tenantId = actor.tenantId!;
      const t = await ctx.deps.repo.tx(async (tx) => {
        const t = await tx.lockTicket(tenantId, id);
        assertTenantTicket(actor, t);
        if (t.version !== body.version) throw new ApiError('VERSION_CONFLICT', undefined, { currentVersion: t.version });
        const patch: TicketPatch = {};
        if (body.status !== undefined && body.status !== t.status) {
          assertStaffTransition(t.status, body.status);
          Object.assign(patch, statusPatch(t, body.status, ctx.now));
        }
        if (body.assigneeId !== undefined && body.assigneeId !== t.assigneeId) {
          if (body.assigneeId !== null) {
            // 같은 테넌트의 활성 상담원/관리자만 배정 가능(다른 테넌트 사용자 id 주입 차단)
            const u = await tx.getTenantUser(tenantId, body.assigneeId);
            if (!u || !isStaff(u.role) || u.status !== 'active') {
              throw new ApiError('VALIDATION_FAILED', '배정할 수 없는 사용자입니다.', [{ path: 'assigneeId', message: 'not an active staff member' }]);
            }
          }
          patch.assigneeId = body.assigneeId;
        }
        if (Object.keys(patch).length === 0) return t;
        const updated = await tx.updateTicketIfVersion(tenantId, t.id, body.version, patch, ctx.now);
        if (!updated) throw new ApiError('VERSION_CONFLICT');
        await tx.audit(
          { tenantId, actorId: actor.userId, action: 'ticket.update', targetType: 'ticket', targetId: t.id, meta: { from: { status: t.status, assigneeId: t.assigneeId }, to: patch } },
          ctx.now,
        );
        return updated;
      });
      return staffDetail(ctx.deps.repo, t);
    },
  });

  // 공개 답변 / 내부 메모. /messages {body, visibility} + 화면용 별칭 /replies, /notes
  r.add({
    method: 'POST',
    pattern: '/t/:slug/admin/tickets/:id/messages',
    auth: 'tenant',
    handler: async (ctx) => {
      const body = await readBody(ctx, staffMessageBody);
      return staffMessage(ctx, body.visibility, body.body);
    },
  });
  r.add({
    method: 'POST',
    pattern: '/t/:slug/admin/tickets/:id/replies',
    auth: 'tenant',
    handler: async (ctx) => staffMessage(ctx, 'public', (await readBody(ctx, messageBody)).body),
  });
  r.add({
    method: 'POST',
    pattern: '/t/:slug/admin/tickets/:id/notes',
    auth: 'tenant',
    handler: async (ctx) => staffMessage(ctx, 'internal', (await readBody(ctx, messageBody)).body),
  });

  // ---------- AI 초안: 승인(=발송)·수정·반려. 티켓 행 잠금 + 초안 version/status 조건 갱신 ----------
  r.add({
    method: 'POST',
    pattern: '/t/:slug/admin/tickets/:id/drafts/:draftId/approve',
    auth: 'tenant',
    handler: async (ctx) => {
      const actor = requireActor(ctx);
      assertCan(actor, 'draft:decide');
      const body = await readBody(ctx, approveDraftBody);
      const t = await withDraft(ctx, actor, async (tx, ticket, draft) => {
        if (ticket.status === 'closed') throw new ApiError('TICKET_CLOSED');
        // 빠른 실패(이미 처리된 초안). 최종 판정은 아래 조건부 갱신이 한다.
        if (draft.version !== body.version || !['draft', 'approved'].includes(draft.status)) throw versionConflict(draft);
        const finalBody = body.body ?? draft.body;
        const settings = await tx.getSettings(ticket.tenantId);
        const policy = { tenantId: ticket.tenantId, allowedLinkDomains: settings?.allowedLinkDomains ?? [] };
        // 순서: 메시지 insert → 초안 조건부 갱신(sent_message_id FK가 즉시 검사되므로 메시지가 먼저 있어야 한다).
        // 갱신이 실패(동시 승인 패자)하면 예외로 트랜잭션 전체가 롤백되어 메시지도 남지 않는다 → 발송 1건, 나머지 409.
        // 티켓 행 잠금(withDraft) 덕분에 같은 티켓의 승인은 직렬화되고, 패자는 승자 커밋 후 version 불일치로 실패한다.
        const msg = await tx.addTicketMessage(
          {
            id: randomUUID(),
            tenantId: ticket.tenantId,
            ticketId: ticket.id,
            authorId: actor.userId, // 승인자
            role: actor.role as 'agent' | 'tenant_admin',
            authorType: 'agent', // 상담원이 승인·발송한 답변(자동답변 아님)
            visibility: 'public',
            body: finalBody,
            // 고객 공개 메시지에는 단일 공개 정책 결과만 {id,title,excerpt?,url?}(점수 등 AI 원본은 초안·ai_runs에만)
            sources: toPublicSources(draft.sources, policy),
            draftId: draft.id,
            sourceJobId: draft.jobId,
          },
          ctx.now,
        );
        const updated = await tx.updateDraftIfVersion(
          ticket.tenantId,
          draft.id,
          body.version,
          ['draft', 'approved'],
          { status: 'sent', body: finalBody, decidedBy: actor.userId, decidedAt: ctx.now, sentMessageId: msg.id },
          ctx.now,
        );
        if (!updated) throw versionConflict(await tx.getDraft(ticket.tenantId, draft.id));
        await tx.audit(
          { tenantId: ticket.tenantId, actorId: actor.userId, action: 'draft.approve_send', targetType: 'ai_draft', targetId: draft.id, meta: { edited: body.body !== undefined && body.body !== draft.body } },
          ctx.now,
        );
        return (await tx.updateTicket(ticket.tenantId, ticket.id, {}, ctx.now))!;
      });
      return staffDetail(ctx.deps.repo, t);
    },
  });

  r.add({
    method: 'PATCH',
    pattern: '/t/:slug/admin/tickets/:id/drafts/:draftId',
    auth: 'tenant',
    handler: async (ctx) => {
      const actor = requireActor(ctx);
      assertCan(actor, 'draft:decide');
      const body = await readBody(ctx, editDraftBody);
      const t = await withDraft(ctx, actor, async (tx, ticket, draft) => {
        const updated = await tx.updateDraftIfVersion(ticket.tenantId, draft.id, body.version, ['draft', 'approved'], { body: body.body }, ctx.now);
        if (!updated) throw versionConflict(await tx.getDraft(ticket.tenantId, draft.id));
        await tx.audit({ tenantId: ticket.tenantId, actorId: actor.userId, action: 'draft.edit', targetType: 'ai_draft', targetId: draft.id }, ctx.now);
        return ticket;
      });
      return staffDetail(ctx.deps.repo, t);
    },
  });

  r.add({
    method: 'POST',
    pattern: '/t/:slug/admin/tickets/:id/drafts/:draftId/reject',
    auth: 'tenant',
    handler: async (ctx) => {
      const actor = requireActor(ctx);
      assertCan(actor, 'draft:decide');
      const body = await readBody(ctx, rejectDraftBody);
      const t = await withDraft(ctx, actor, async (tx, ticket, draft) => {
        const updated = await tx.updateDraftIfVersion(
          ticket.tenantId,
          draft.id,
          body.version,
          ['draft', 'approved'],
          { status: 'rejected', decidedBy: actor.userId, decidedAt: ctx.now, rejectReason: body.reason ?? null },
          ctx.now,
        );
        if (!updated) throw versionConflict(await tx.getDraft(ticket.tenantId, draft.id));
        await tx.audit({ tenantId: ticket.tenantId, actorId: actor.userId, action: 'draft.reject', targetType: 'ai_draft', targetId: draft.id }, ctx.now);
        return ticket;
      });
      return staffDetail(ctx.deps.repo, t);
    },
  });

  // 초안 재생성 요청 → 큐 등록(같은 티켓에 진행 중인 재생성 작업이 있으면 409)
  r.add({
    method: 'POST',
    pattern: '/t/:slug/admin/tickets/:id/drafts/regenerate',
    auth: 'tenant',
    handler: async (ctx) => {
      const actor = requireActor(ctx);
      assertCan(actor, 'draft:regenerate');
      const id = idParam(ctx, 'id');
      const requestId = idempotencyKeyHeader(ctx) ?? randomUUID();
      const tenantId = actor.tenantId!;
      const jobId = await ctx.deps.repo.tx(async (tx) => {
        // 티켓 행 잠금으로 같은 티켓의 동시 재생성 요청을 직렬화
        const t = await tx.lockTicket(tenantId, id);
        assertTenantTicket(actor, t);
        if (t.status === 'closed') throw new ApiError('TICKET_CLOSED');
        const active = await tx.findActiveJob(tenantId, t.id, 'regenerate_draft');
        if (active) throw new ApiError('JOB_IN_PROGRESS', undefined, { jobId: active.id });
        const { jobId } = await ctx.deps.queue.enqueueRegenerate(tx, { tenantId, ticketId: t.id, requestId }, ctx.now);
        await tx.audit({ tenantId, actorId: actor.userId, action: 'draft.regenerate_request', targetType: 'ticket', targetId: t.id, meta: { jobId } }, ctx.now);
        return jobId;
      });
      return Response.json({ jobId, status: 'queued' }, { status: 202 });
    },
  });

  // KPI 3개: 자동해결률(고객 해결 확인 기준), 이관률, 카테고리 분포
  r.add({
    method: 'GET',
    pattern: '/t/:slug/admin/metrics',
    auth: 'tenant',
    handler: async (ctx) => {
      const actor = requireActor(ctx);
      assertCan(actor, 'tenant:metrics');
      const m = await ctx.deps.repo.tenantMetrics(actor.tenantId!);
      return { ...m, ...kpis(m), aiMode: ctx.deps.cfg.aiMode };
    },
  });
}

export function kpis(m: { ticketsTotal: number; autoResolvedTickets: number; escalatedTickets: number }) {
  const rate = (n: number) => (m.ticketsTotal === 0 ? 0 : Math.round((n / m.ticketsTotal) * 1000) / 1000);
  return { autoResolutionRate: rate(m.autoResolvedTickets), escalationRate: rate(m.escalatedTickets) };
}

function statusPatch(t: Ticket, to: TicketStatus, now: Date): TicketPatch {
  const p: TicketPatch = { status: to };
  if (to === 'resolved') Object.assign(p, { resolvedAt: now, resolvedByCustomer: false });
  if (to === 'closed') p.closedAt = now;
  if ((to === 'open' || to === 'in_progress') && t.status === 'resolved') Object.assign(p, { resolvedAt: null, resolvedByCustomer: false });
  return p;
}

/** 공개 답변은 티켓 행 잠금 후 insert(워커 자동답변과 직렬화 → 상담원 답변 뒤 늦은 AI 발송 차단). */
async function staffMessage(ctx: Ctx, visibility: 'public' | 'internal', text: string) {
  const actor = requireActor(ctx);
  assertCan(actor, visibility === 'public' ? 'ticket:reply' : 'ticket:note');
  const id = idParam(ctx, 'id');
  const tenantId = actor.tenantId!;
  const t = await ctx.deps.repo.tx(async (tx) => {
    const t = await tx.lockTicket(tenantId, id);
    assertTenantTicket(actor, t);
    if (visibility === 'public' && t.status === 'closed') throw new ApiError('TICKET_CLOSED');
    await tx.addTicketMessage(
      {
        id: randomUUID(),
        tenantId,
        ticketId: t.id,
        authorId: actor.userId,
        role: actor.role as 'agent' | 'tenant_admin',
        authorType: 'agent',
        visibility,
        body: text,
        sources: null,
        draftId: null,
        sourceJobId: null,
      },
      ctx.now,
    );
    await tx.audit({ tenantId, actorId: actor.userId, action: visibility === 'public' ? 'ticket.reply' : 'ticket.note', targetType: 'ticket', targetId: t.id }, ctx.now);
    return (await tx.updateTicket(tenantId, t.id, {}, ctx.now))!;
  });
  return Response.json(await staffDetail(ctx.deps.repo, t), { status: 201 });
}

function versionConflict(current: AiDraft | null) {
  return new ApiError('VERSION_CONFLICT', undefined, current ? { current: toDraft(current) } : null);
}

async function withDraft(ctx: Ctx, actor: Actor, fn: (tx: Repo, ticket: Ticket, draft: AiDraft) => Promise<Ticket>): Promise<Ticket> {
  const id = idParam(ctx, 'id');
  const draftId = idParam(ctx, 'draftId');
  const tenantId = actor.tenantId!;
  return ctx.deps.repo.tx(async (tx) => {
    const ticket = await tx.lockTicket(tenantId, id);
    assertTenantTicket(actor, ticket);
    const draft = await tx.getDraft(tenantId, draftId);
    if (!draft || draft.ticketId !== ticket.id) throw new ApiError('NOT_FOUND');
    return fn(tx, ticket, draft);
  });
}

async function staffDetail(repo: Repo, t: Ticket) {
  const [messages, drafts, runs] = await Promise.all([
    repo.listTicketMessages(t.tenantId, t.id),
    repo.listDrafts(t.tenantId, t.id),
    repo.listRuns(t.tenantId, t.id, t.conversationId),
  ]);
  const names = await nameBook(repo, t.tenantId, [t.customerId, t.assigneeId, ...messages.map((m) => m.authorId)]);
  return toStaffTicketDetail(t, messages, drafts, runs, names);
}
