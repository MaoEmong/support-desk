import { createProvider, loadAIConfig } from '@support/ai';
import { db } from '@support/db';
import { createAiChatResponder } from './ai/chat';
import { createKbRepository, createPipelineDeps, createSettingsReader } from './ai/deps';
import { createJobQueue } from './ai/queue';
import { createApp, type App } from './app';
import { loadConfig } from './config';
import { DrizzleRepo } from './repo/drizzle';

/**
 * 운영 의존성 조립: PostgreSQL(Drizzle) 저장소 + DB 작업 큐 + 챗봇 응답기(@support/ai streamInquiry).
 * 게시판 문의는 워커(worker-bootstrap.ts)가 같은 deps로 처리한다.
 */
let app: App | null = null;

export function getApp(): App {
  if (!app) {
    const cfg = loadConfig();
    const provider = createProvider(loadAIConfig({ ...process.env, AI_MODE: cfg.aiMode }));
    const kb = createKbRepository(db);
    const pipeline = createPipelineDeps({ db, provider, settings: createSettingsReader(db), kb });
    app = createApp({
      repo: new DrizzleRepo(db),
      cfg,
      queue: createJobQueue({ pipelineVersion: cfg.pipelineVersion }),
      chat: createAiChatResponder(pipeline),
      clock: () => new Date(),
      // 같은 프로세스의 KB 변경은 즉시 캐시 비움(다른 프로세스는 kbRevision으로 무효화)
      kbChanged: (tenantId) => kb.invalidate(tenantId),
    });
  }
  return app;
}
