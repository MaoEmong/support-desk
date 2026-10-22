/**
 * 고객 공개 근거의 단일 정책. 저장(SSE 답변·상담원 승인 발송)과 모든 응답 DTO가 이 함수만 쓴다.
 *   ① 소속: tenantId가 표시된 항목은 같은 테넌트만(다른 테넌트 근거는 항목째 제외)
 *   ② 키: 공용 순수 projection(@support/queue projectPublicSources) → {id,title,excerpt?,url?}.
 *      이전 형식(kbArticleId) 행도 id로 읽는다(기존 데이터는 바꾸지 않음).
 *   ③ URL: https + 테넌트 allowedLinkDomains(하위 도메인 포함)일 때만 유지, 아니면 url 키 생략.
 *      응답 때도 다시 적용하므로 큐가 저장한 행·도메인 설정 변경 후의 행도 같은 규칙을 따른다.
 */
import { isAllowedUrl } from '@support/ai';
import { projectPublicSources } from '@support/queue';
import type { PublicSource } from './domain';

export interface SourcePolicy {
  tenantId: string;
  allowedLinkDomains: readonly string[];
}

function foreignTenant(item: unknown, tenantId: string): boolean {
  return typeof item === 'object' && item !== null && 'tenantId' in item && typeof item.tenantId === 'string' && item.tenantId !== tenantId;
}

export function toPublicSources(raw: unknown, policy: SourcePolicy): PublicSource[] {
  if (!Array.isArray(raw)) return [];
  const own = raw.filter((item) => !foreignTenant(item, policy.tenantId));
  return projectPublicSources(own).map(({ url, ...rest }) => (url !== undefined && isAllowedUrl(url, policy.allowedLinkDomains) ? { ...rest, url } : rest));
}
