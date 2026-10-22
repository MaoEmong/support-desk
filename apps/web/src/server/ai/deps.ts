/**
 * @support/ai 파이프라인 의존성(web SSE와 독립 worker 공용).
 * - Node 전용·Next 비의존: @support/db·@support/ai·drizzle-orm만 import한다(worker-bootstrap이 fileURL로 불러온다).
 * - 모든 조회는 tenantId 조건을 쿼리에 넣는다. 결과 소속은 파이프라인이 다시 검증한다.
 * - 설정은 캐시하지 않는다(관리자 변경 즉시 반영). KB는 공개(published) 문서만.
 */
import { and, count, desc, eq } from 'drizzle-orm';
import {
  createCachedKbRepository,
  parseTenantSettingsRow,
  type AIProvider,
  type CachedKbRepository,
  type InquiryContext,
  type InquiryReader,
  type KbArticle,
  type KbRepository,
  type KbRevision,
  type PipelineDeps,
  type PipelineLogger,
  type ProcessInquiryInput,
  type SettingsReader,
} from '@support/ai';
import { conversationMessages, kbArticles, tenantSettings, ticketMessages, tickets, type Database } from '@support/db';

export type AiDb = Database;

/** 문의 원문 + 이미 나간 자동답변 수. 다른 테넌트·다른 티켓/대화·내부 메모·상담원 메시지면 null. */
export function createInquiryReader(db: AiDb): InquiryReader {
  return {
    async getInquiryContext(input: ProcessInquiryInput): Promise<InquiryContext | null> {
      if (input.ticketId) {
        const [row] = await db
          .select({ id: ticketMessages.id, body: ticketMessages.body, autoReplyCount: tickets.autoReplyCount })
          .from(ticketMessages)
          .innerJoin(tickets, and(eq(tickets.id, ticketMessages.ticketId), eq(tickets.tenantId, ticketMessages.tenantId)))
          .where(
            and(
              eq(ticketMessages.id, input.messageId),
              eq(ticketMessages.tenantId, input.tenantId),
              eq(ticketMessages.ticketId, input.ticketId),
              eq(ticketMessages.role, 'customer'),
              eq(ticketMessages.visibility, 'public'),
            ),
          )
          .limit(1);
        return row ? { message: { id: row.id, body: row.body }, autoAnswerCount: row.autoReplyCount } : null;
      }
      if (!input.conversationId) return null;
      const [msg] = await db
        .select({ id: conversationMessages.id, body: conversationMessages.body })
        .from(conversationMessages)
        .where(
          and(
            eq(conversationMessages.id, input.messageId),
            eq(conversationMessages.tenantId, input.tenantId),
            eq(conversationMessages.conversationId, input.conversationId),
            eq(conversationMessages.role, 'user'),
          ),
        )
        .limit(1);
      if (!msg) return null;
      // 대화에서 이미 고객에게 나간 AI 답변 수(테넌트 autoAnswerLimit 판단용)
      const [n] = await db
        .select({ n: count() })
        .from(conversationMessages)
        .where(
          and(
            eq(conversationMessages.tenantId, input.tenantId),
            eq(conversationMessages.conversationId, input.conversationId),
            eq(conversationMessages.role, 'assistant'),
          ),
        );
      return { message: { id: msg.id, body: msg.body }, autoAnswerCount: n?.n ?? 0 };
    },
  };
}

/** 테넌트의 공개 KB 문서. 캐시 로더로 쓴다. */
export async function loadPublishedKbArticles(db: AiDb, tenantId: string): Promise<KbArticle[]> {
  const rows = await db
    .select()
    .from(kbArticles)
    .where(and(eq(kbArticles.tenantId, tenantId), eq(kbArticles.published, true)));
  return rows.map((r) => ({
    id: r.id,
    tenantId: r.tenantId,
    title: r.title,
    question: r.question,
    body: r.body,
    category: r.category ?? '',
    tags: r.tags,
  }));
}

/** 재생성 작업(messageId 없음)용: 티켓의 마지막 공개 고객 메시지 */
export async function latestCustomerMessageId(db: AiDb, tenantId: string, ticketId: string): Promise<string | null> {
  const [row] = await db
    .select({ id: ticketMessages.id })
    .from(ticketMessages)
    .where(
      and(
        eq(ticketMessages.tenantId, tenantId),
        eq(ticketMessages.ticketId, ticketId),
        eq(ticketMessages.role, 'customer'),
        eq(ticketMessages.visibility, 'public'),
      ),
    )
    .orderBy(desc(ticketMessages.createdAt))
    .limit(1);
  return row?.id ?? null;
}

/** 테넌트 KB 버전(tenant_settings.kb_revision). KB 생성·수정·삭제와 같은 tx에서 +1. 설정 행이 없으면 null */
export async function getKbRevision(db: AiDb, tenantId: string): Promise<KbRevision | null> {
  const [row] = await db
    .select({ kbRevision: tenantSettings.kbRevision })
    .from(tenantSettings)
    .where(eq(tenantSettings.tenantId, tenantId))
    .limit(1);
  return row ? row.kbRevision : null;
}

/**
 * 공개 KB 캐시 저장소. web·worker는 별도 프로세스·별도 캐시 인스턴스이므로
 * 검색마다 getKbRevision을 확인해 버전이 바뀌면 다시 읽는다(같은 프로세스는 invalidate로 즉시, TTL은 안전망).
 */
export function createKbRepository(db: AiDb, opts: { ttlMs?: number } = {}): CachedKbRepository {
  return createCachedKbRepository((tenantId) => loadPublishedKbArticles(db, tenantId), {
    ...(opts.ttlMs !== undefined ? { ttlMs: opts.ttlMs } : {}),
    getRevision: (tenantId) => getKbRevision(db, tenantId),
  });
}

/** 파이프라인 의존성 조합. settings는 캐시 없는 리더를 주입한다. */
export function createPipelineDeps(args: {
  db: AiDb;
  provider: AIProvider;
  settings: SettingsReader;
  kb?: KbRepository;
  logger?: PipelineLogger;
}): PipelineDeps {
  return {
    provider: args.provider,
    kb: args.kb ?? createKbRepository(args.db),
    inquiries: createInquiryReader(args.db),
    settings: args.settings,
    ...(args.logger ? { logger: args.logger } : {}),
  };
}

/**
 * 테넌트 AI 설정. 캐시하지 않는다(관리자 변경이 다음 문의부터 바로 반영).
 * 행 매핑·검증은 @support/ai parseTenantSettingsRow 한 곳에서: 잘못된 설정이면 AIConfigError →
 * 파이프라인이 error.code=CONFIG_ERROR, reason ai_error로 이관한다(잘못된 설정으로 자동답변하지 않음).
 */
export function createSettingsReader(db: AiDb): SettingsReader {
  return {
    async getTenantAISettings(tenantId) {
      const [row] = await db.select().from(tenantSettings).where(eq(tenantSettings.tenantId, tenantId)).limit(1);
      return row ? parseTenantSettingsRow(row) : null;
    },
  };
}
