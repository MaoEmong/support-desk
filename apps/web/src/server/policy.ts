import type { Actor, Role, Ticket, TicketStatus } from './domain';
import { ApiError } from './errors';

/**
 * 역할 정책 단일 모듈. 라우트·서비스는 여기의 can()/assert*만 쓴다.
 *
 * 원칙
 * - 테넌트 일치는 tenant-guard가 먼저 보장한다(세션 tenantId === 경로 slug의 tenantId).
 * - 다른 고객의 리소스는 403이 아니라 404(존재 숨김).
 * - platform_admin은 어떤 테넌트 리소스 본문에도 접근 못 한다. 집계 API만 허용.
 */
export type Action =
  | 'ticket:create'
  | 'ticket:read_own'
  | 'ticket:comment_own'
  | 'ticket:confirm_resolved'
  | 'conversation:use'
  | 'queue:read'
  | 'ticket:reply'
  | 'ticket:note'
  | 'ticket:assign'
  | 'ticket:set_status'
  | 'draft:decide'
  | 'draft:regenerate'
  | 'tenant:metrics'
  | 'settings:read'
  | 'settings:write'
  | 'kb:read'
  | 'kb:write'
  | 'agents:read'
  | 'agents:manage'
  | 'platform:aggregate';

const MATRIX: Record<Action, readonly Role[]> = {
  'ticket:create': ['customer'],
  'ticket:read_own': ['customer'],
  'ticket:comment_own': ['customer'],
  'ticket:confirm_resolved': ['customer'],
  'conversation:use': ['customer'],
  'queue:read': ['agent', 'tenant_admin'],
  'ticket:reply': ['agent', 'tenant_admin'],
  'ticket:note': ['agent', 'tenant_admin'],
  'ticket:assign': ['agent', 'tenant_admin'],
  'ticket:set_status': ['agent', 'tenant_admin'],
  'draft:decide': ['agent', 'tenant_admin'],
  'draft:regenerate': ['agent', 'tenant_admin'],
  'tenant:metrics': ['agent', 'tenant_admin'],
  'settings:read': ['tenant_admin'],
  'settings:write': ['tenant_admin'],
  'kb:read': ['agent', 'tenant_admin'],
  'kb:write': ['tenant_admin'],
  'agents:read': ['agent', 'tenant_admin'],
  'agents:manage': ['tenant_admin'],
  'platform:aggregate': ['platform_admin'],
};

export const can = (role: Role, action: Action) => MATRIX[action].includes(role);

export function assertCan(actor: Actor, action: Action) {
  if (!can(actor.role, action)) throw new ApiError('FORBIDDEN', undefined, { action });
}

export const isStaff = (role: Role) => role === 'agent' || role === 'tenant_admin';

/** 고객 본인 티켓만. 아니면 404(존재 숨김). tenant는 저장소 쿼리에서 이미 걸러진다. */
export function assertOwnTicket(actor: Actor, ticket: Ticket | null): asserts ticket is Ticket {
  if (!ticket || ticket.tenantId !== actor.tenantId || ticket.customerId !== actor.userId) {
    throw new ApiError('NOT_FOUND');
  }
}

export function assertTenantTicket(actor: Actor, ticket: Ticket | null): asserts ticket is Ticket {
  if (!ticket || ticket.tenantId !== actor.tenantId) throw new ApiError('NOT_FOUND');
}

/** 상담원 상태 전이 규칙. resolved→open은 고객 재문의로만 일어난다. */
const STAFF_TRANSITIONS: Record<TicketStatus, readonly TicketStatus[]> = {
  open: ['in_progress', 'resolved', 'closed'],
  in_progress: ['open', 'resolved', 'closed'],
  resolved: ['in_progress', 'closed'],
  closed: [],
};

export function assertStaffTransition(from: TicketStatus, to: TicketStatus) {
  if (!STAFF_TRANSITIONS[from].includes(to)) {
    throw new ApiError('INVALID_TRANSITION', undefined, { from, to, allowed: STAFF_TRANSITIONS[from] });
  }
}

export const staffTransitions = STAFF_TRANSITIONS;
