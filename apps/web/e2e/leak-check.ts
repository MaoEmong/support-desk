import { expect } from '@playwright/test';
import { ConversationMessageSchema, SourceSchema, SSEEventSchema, type SSEEvent } from '@support/contracts';

export const INTERNAL_STRINGS = [
  'confidence', 'decision', 'reasonDetail', '결합 확신도', '임계값',
  'mock-keyword-v1', 'injectionSuspected', 'removedOutputLinks',
  '금지 카테고리 키워드', '담당 상담원이 직접 확인한 뒤',
] as const;

export function assertNoInternalStrings(text: string, where: string) {
  for (const forbidden of INTERNAL_STRINGS) {
    expect(text.includes(forbidden), `${where}: 내부 문자열 ${JSON.stringify(forbidden)} 노출`).toBe(false);
  }
}

function object(value: unknown, where: string): Record<string, unknown> {
  expect(value !== null && typeof value === 'object' && !Array.isArray(value), `${where}: JSON 객체여야 합니다.`).toBe(true);
  return value as Record<string, unknown>;
}

function keys(value: unknown, allowed: readonly string[], where: string) {
  const row = object(value, where);
  for (const key of Object.keys(row)) expect(allowed, `${where}: 비공개 키 ${JSON.stringify(key)} 노출`).toContain(key);
  return row;
}

function array(value: unknown, where: string): unknown[] {
  expect(Array.isArray(value), `${where}: 배열이어야 합니다.`).toBe(true);
  return value as unknown[];
}

function sources(value: unknown, where: string) {
  for (const [i, source] of array(value, where).entries()) {
    const location = `${where}[${i}]`;
    keys(source, ['id', 'title', 'excerpt', 'url'], location);
    const result = SourceSchema.safeParse(source);
    expect(result.success, `${location}: 공개 source 계약 불일치 ${result.success ? '' : result.error.message}`).toBe(true);
  }
}

export interface SSEFrame { event: string; data: unknown }

/** Complete wire parser: CR/LF, multiline data, comments/heartbeats and final EOF frame. */
export function parseSSEWire(wire: string, where = 'SSE'): SSEFrame[] {
  const frames: SSEFrame[] = [];
  for (const [index, block] of wire.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n').split('\n\n').entries()) {
    let event = 'message';
    const data: string[] = [];
    for (const line of block.split('\n')) {
      if (!line || line.startsWith(':')) continue;
      const colon = line.indexOf(':');
      const field = colon < 0 ? line : line.slice(0, colon);
      let value = colon < 0 ? '' : line.slice(colon + 1);
      if (value.startsWith(' ')) value = value.slice(1);
      if (field === 'event') event = value;
      else if (field === 'data') data.push(value);
      // id/retry and unknown SSE transport fields do not become application data.
    }
    if (!data.length) continue; // e.g. ': ping\n\n'
    try { frames.push({ event, data: JSON.parse(data.join('\n')) }); }
    catch { throw new Error(`${where}: 프레임 ${index} (${event}) data가 올바른 JSON이 아닙니다.`); }
  }
  return frames;
}

const SSE_KEYS: Record<SSEEvent['event'], readonly string[]> = {
  classified: ['category', 'conversationId'], sources: ['sources'], token: ['token'],
  escalated: ['reason', 'message'], done: ['conversationId', 'messageId', 'ticketId'],
  error: ['code', 'message', 'details'],
};

export function assertPublicSSEWire(wire: string, where: string): SSEEvent[] {
  assertNoInternalStrings(wire, where);
  const frames = parseSSEWire(wire, where);
  expect(frames.length, `${where}: 공개 이벤트가 없습니다.`).toBeGreaterThan(0);
  return frames.map((frame, index) => {
    const location = `${where} frame[${index}].${frame.event}`;
    expect(Object.hasOwn(SSE_KEYS, frame.event), `${location}: 알 수 없는 공개 이벤트`).toBe(true);
    const data = keys(frame.data, SSE_KEYS[frame.event as SSEEvent['event']], location);
    // Check the original object before parsing: non-strict Zod branches can strip extra keys.
    assertNoInternalStrings(JSON.stringify(data), location);
    if (frame.event === 'sources') sources(data.sources, `${location}.sources`);
    const result = SSEEventSchema.safeParse(frame);
    expect(result.success, `${location}: 공개 SSE 계약 불일치 ${result.success ? '' : result.error.message}`).toBe(true);
    if (!result.success) throw new Error(`${location}: 공개 SSE 계약 불일치`);
    return result.data;
  });
}

export function assertPublicConversation(value: unknown, where: string) {
  assertNoInternalStrings(JSON.stringify(value), where);
  const conversation = keys(value, ['id', 'status', 'ticketId', 'createdAt', 'updatedAt', 'messages'], where);
  for (const [i, message] of array(conversation.messages, `${where}.messages`).entries()) {
    const location = `${where}.messages[${i}]`;
    const row = object(message, location);
    keys(row, ['id', 'role', 'body', 'sources', 'createdAt', ...(row.role === 'system' ? ['escalationReason', 'noticeCode'] : [])], location);
    sources(row.sources, `${location}.sources`);
    const result = ConversationMessageSchema.safeParse(row);
    expect(result.success, `${location}: 공개 대화 메시지 계약 불일치 ${result.success ? '' : result.error.message}`).toBe(true);
  }
}

export function assertPublicCustomerTicket(value: unknown, where: string) {
  assertNoInternalStrings(JSON.stringify(value), where);
  const ticket = keys(value, [
    'id', 'title', 'body', 'status', 'version', 'customerStatus', 'createdAt', 'updatedAt',
    'resolvedAt', 'closedAt', 'canConfirmResolved', 'canComment', 'messages',
  ], where);
  for (const [i, message] of array(ticket.messages, `${where}.messages`).entries()) {
    const location = `${where}.messages[${i}]`;
    const row = keys(message, ['id', 'role', 'authorType', 'authorName', 'body', 'sources', 'createdAt'], location);
    sources(row.sources, `${location}.sources`);
  }
}
