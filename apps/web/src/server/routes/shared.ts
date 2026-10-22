import type { NameBook } from '../dto';
import type { Repo } from '../repo/types';

/** 응답에 필요한 사용자 이름만 모은다. 반드시 같은 테넌트 사용자만 조회한다. */
export async function nameBook(repo: Repo, tenantId: string, ids: Array<string | null | undefined>): Promise<NameBook> {
  const users: NameBook['users'] = new Map();
  for (const id of new Set(ids.filter((x): x is string => !!x))) {
    const u = await repo.getTenantUser(tenantId, id);
    if (u) users.set(u.id, { id: u.id, name: u.name, email: u.email, role: u.role });
  }
  const s = await repo.getSettings(tenantId);
  return { users, chatbotName: s?.chatbotName ?? 'AI', sources: { tenantId, allowedLinkDomains: s?.allowedLinkDomains ?? [] } };
}
