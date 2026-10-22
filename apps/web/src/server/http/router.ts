import type { Ctx } from './context';

export type Method = 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';

/**
 * 라우트 인증 모드
 * - public:   인증 불필요. /t/{slug}면 테넌트만 해석
 * - tenant:   테넌트 세션 필수 + 세션 tenantId === slug 테넌트
 * - platform: 플랫폼 관리자 세션(별도 쿠키) 필수
 */
export type AuthMode = 'public' | 'tenant' | 'platform';

export interface Route {
  method: Method;
  pattern: string;
  auth: AuthMode;
  handler: (ctx: Ctx) => Promise<unknown>;
}

interface Compiled extends Route {
  segments: string[];
}

export class Router {
  private routes: Compiled[] = [];

  add(r: Route) {
    this.routes.push({ ...r, segments: split(r.pattern) });
    return this;
  }

  match(method: string, path: string): { route: Compiled; params: Record<string, string> } | 'method_not_allowed' | null {
    const parts = split(path);
    let pathMatched = false;
    for (const r of this.routes) {
      const params = matchSegments(r.segments, parts);
      if (!params) continue;
      pathMatched = true;
      if (r.method === method) return { route: r, params };
    }
    return pathMatched ? 'method_not_allowed' : null;
  }
}

const split = (p: string) => p.split('/').filter(Boolean);

function matchSegments(pattern: string[], parts: string[]): Record<string, string> | null {
  if (pattern.length !== parts.length) return null;
  const params: Record<string, string> = {};
  for (let i = 0; i < pattern.length; i++) {
    const p = pattern[i]!;
    let v: string;
    try {
      v = decodeURIComponent(parts[i]!);
    } catch {
      return null;
    }
    if (p.startsWith(':')) params[p.slice(1)] = v;
    else if (p !== v) return null;
  }
  return params;
}
