import type { Repo } from '../repo/types';

/**
 * AI 작업 큐 인터페이스(생산자 측).
 * 반드시 호출자의 트랜잭션 repo(tx)로 등록해 "문의 저장 ↔ 작업 등록"이 원자적으로 묶이게 한다.
 * Postgres 구현에서 tx.enqueueJob은 @support/queue의 enqueueInquiry를 같은 트랜잭션 executor로 호출한다.
 * 소비자(워커: lease·복구·재시도·이관·자동답변 1회)는 @support/queue InquiryQueue 담당.
 */
export interface AiJobQueue {
  enqueueInquiry(tx: Repo, input: { tenantId: string; ticketId: string; messageId: string }, now: Date): Promise<{ jobId: string }>;
  enqueueRegenerate(tx: Repo, input: { tenantId: string; ticketId: string; requestId: string }, now: Date): Promise<{ jobId: string }>;
}

/** 계약: 키는 대상·messageId·pipelineVersion으로 결정(같은 메시지 재등록 시 중복 작업 없음) */
export const inquiryJobKey = (ticketId: string, messageId: string, pipelineVersion: string) =>
  `ticket:${ticketId}:message:${messageId}:${pipelineVersion}`;

export function createJobQueue(opts: { pipelineVersion: string; maxAttempts?: number }): AiJobQueue {
  const maxAttempts = opts.maxAttempts ?? 3;
  return {
    enqueueInquiry(tx, input, now) {
      return tx.enqueueJob(
        {
          tenantId: input.tenantId,
          kind: 'process_inquiry',
          ticketId: input.ticketId,
          messageId: input.messageId,
          idempotencyKey: inquiryJobKey(input.ticketId, input.messageId, opts.pipelineVersion),
          pipelineVersion: opts.pipelineVersion,
          maxAttempts,
        },
        now,
      );
    },
    enqueueRegenerate(tx, input, now) {
      return tx.enqueueJob(
        {
          tenantId: input.tenantId,
          kind: 'regenerate_draft',
          ticketId: input.ticketId,
          messageId: null,
          idempotencyKey: `ticket:${input.ticketId}:regenerate:${input.requestId}:${opts.pipelineVersion}`,
          pipelineVersion: opts.pipelineVersion,
          maxAttempts,
        },
        now,
      );
    },
  };
}
