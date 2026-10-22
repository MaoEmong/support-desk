/**
 * 출력 sanitize: AI 가 만든 텍스트를 "허용 마크다운"으로만 남긴다.
 * - HTML 태그는 전부 제거(렌더러가 HTML 을 해석하지 않더라도 이중 방어)
 * - 이미지 문법 제거
 * - 링크는 https + 허용 도메인(하위 도메인 포함)만 남기고, 나머지는 링크 텍스트만 남긴다
 * - 맨 URL 도 같은 규칙으로 걸러낸다
 * - javascript:, data: 등 위험 스킴 제거
 * 허용: 문단, 목록(-, 1.), **굵게**, *기울임*, `코드`, 허용 도메인 링크
 */

export interface SanitizeResult {
  text: string;
  removedLinks: string[];
}

export function hostOf(url: string): string | null {
  try {
    const u = new URL(url);
    return u.hostname.toLowerCase();
  } catch {
    return null;
  }
}

export function isAllowedUrl(url: string, allowedDomains: readonly string[]): boolean {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  if (u.protocol !== 'https:') return false;
  if (u.username || u.password) return false;
  const host = u.hostname.toLowerCase();
  return allowedDomains.some((d) => {
    const dom = d.toLowerCase();
    return host === dom || host.endsWith(`.${dom}`);
  });
}

// 문자 클래스 안의 "[" 는 이스케이프가 필요 없다("]" 만 필요).
const URL_RE = /\b(?:https?:\/\/|www\.)[^\s<>()[\]]+/gi;
// 스킴 없이 쓴 도메인(예: free-gems.evil.example/path)
const BARE_DOMAIN_RE = /\b(?:[a-z0-9-]+\.)+(?:com|net|org|io|co|kr|example|xyz|gg|info|biz|me|app|dev|link|site|shop)(?:\/[^\s<>()[\]]*)?/gi;

/**
 * 5단계에서 마크다운 링크를 잠시 치워 둘 자리표시 문자. 유니코드 사용자 정의 영역(U+E000)이라
 * 제어문자 정규식이 필요 없다. 입력에 같은 문자가 있으면 자리표시를 위조할 수 있으므로 처음에 제거한다.
 */
const PLACEHOLDER = '';
const PLACEHOLDER_RE = /(\d+)/g;
const PLACEHOLDER_CHAR_RE = //g;

/** 고객 메시지·출력에 들어 있는 URL(스킴 없는 도메인 포함)을 뽑는다. */
export function extractUrls(text: string): string[] {
  const found = new Set<string>();
  for (const m of text.match(URL_RE) ?? []) found.add(trimUrl(m));
  const withoutSchemed = text.replace(URL_RE, ' ');
  for (const m of withoutSchemed.match(BARE_DOMAIN_RE) ?? []) found.add(trimUrl(m));
  return [...found];
}

function trimUrl(u: string): string {
  return u.replace(/[.,;:!?'"’”)]+$/, '');
}

function toAbsolute(u: string): string {
  return /^https?:\/\//i.test(u) ? u : `https://${u.replace(/^www\./i, 'www.')}`;
}

export function findDisallowedUrls(text: string, allowedDomains: readonly string[]): string[] {
  return extractUrls(text).filter((u) => !isAllowedUrl(/^http:\/\//i.test(u) ? u : toAbsolute(u), allowedDomains));
}

export function sanitizeOutput(input: string, allowedDomains: readonly string[]): SanitizeResult {
  const removed: string[] = [];
  let text = input.replace(/\r\n?/g, '\n').replace(PLACEHOLDER_CHAR_RE, '');

  // 1) HTML 주석·태그 제거
  text = text.replace(/<!--[\s\S]*?-->/g, '');
  text = text.replace(/<\/?[a-z][^>]*>/gi, '');

  // 2) 이미지 ![alt](url) → alt
  text = text.replace(/!\[([^\]]*)\]\(([^)]*)\)/g, (_m, alt: string, url: string) => {
    removed.push(url.trim());
    return alt;
  });

  // 3) 마크다운 링크 [text](url) → 허용이면 유지, 아니면 text 만
  const kept: string[] = [];
  text = text.replace(/\[([^\]]*)\]\(([^)\s]*)(?:\s+"[^"]*")?\)/g, (_m, label: string, url: string) => {
    const target = url.trim();
    if (isAllowedUrl(target, allowedDomains)) {
      kept.push(target);
      return `[${label}](${target})`;
    }
    removed.push(target);
    return label;
  });

  // 4) 참조형 링크 정의 [id]: url 제거
  text = text.replace(/^\s*\[[^\]]+\]:\s*\S+.*$/gm, (line) => {
    removed.push(line.trim());
    return '';
  });

  // 5) 맨 URL·스킴 없는 도메인: 마크다운 링크 바깥에 있는 것만 검사
  const linkPlaceholders: string[] = [];
  text = text.replace(/\[[^\]]*\]\([^)]*\)/g, (m) => {
    linkPlaceholders.push(m);
    return `${PLACEHOLDER}${linkPlaceholders.length - 1}${PLACEHOLDER}`;
  });
  text = text.replace(URL_RE, (m) => {
    const u = trimUrl(m);
    const tail = m.slice(u.length);
    if (isAllowedUrl(toAbsolute(u), allowedDomains) && !/^http:\/\//i.test(u)) return m;
    removed.push(u);
    return `[링크 삭제됨]${tail}`;
  });
  text = text.replace(BARE_DOMAIN_RE, (m) => {
    const u = trimUrl(m);
    const tail = m.slice(u.length);
    if (isAllowedUrl(toAbsolute(u), allowedDomains)) return m;
    removed.push(u);
    return `[링크 삭제됨]${tail}`;
  });
  text = text.replace(PLACEHOLDER_RE, (_m, i: string) => linkPlaceholders[Number(i)] ?? '');

  // 6) 위험 스킴 잔여물
  text = text.replace(/\b(?:javascript|vbscript|data|file):[^\s)]*/gi, (m) => {
    removed.push(m);
    return '';
  });

  // 7) 허용하지 않는 블록 문법 정리: 제목(#)은 굵게로, 표·구분선은 그대로 두되 HTML 엔티티 이스케이프는 렌더러 몫
  text = text.replace(/^#{1,6}\s+(.+)$/gm, '**$1**');
  text = text.replace(/\n{3,}/g, '\n\n').trim();

  return { text, removedLinks: removed };
}
