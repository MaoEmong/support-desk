import { errorResponse, ApiError } from './errors';
import { clientIp, type Ctx, type Deps } from './http/context';
import { parseCookies } from './http/cookies';
import { Router } from './http/router';
import { registerAdminRoutes } from './routes/admin';
import { registerAgentRoutes } from './routes/agents';
import { registerAuthRoutes } from './routes/auth';
import { registerConversationRoutes } from './routes/conversations';
import { registerCustomerRoutes } from './routes/customer';
import { registerPlatformRoutes } from './routes/platform';
import { registerStaffRoutes } from './routes/staff';
import { runGuards } from './tenant-guard';

export const API_PREFIX = '/api';

export function buildRouter() {
  const r = new Router();
  registerAuthRoutes(r);
  registerCustomerRoutes(r);
  registerStaffRoutes(r);
  registerAdminRoutes(r);
  registerAgentRoutes(r);
  registerConversationRoutes(r);
  registerPlatformRoutes(r);
  return r;
}

/** 프레임워크 독립 앱: Request → Response. Next 라우트와 테스트가 같은 경로를 탄다. */
export function createApp(deps: Deps) {
  const router = buildRouter();

  async function handle(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const path = url.pathname.startsWith(API_PREFIX) ? url.pathname.slice(API_PREFIX.length) : url.pathname;
    const ctx: Ctx = {
      req,
      url,
      params: {},
      deps,
      now: deps.clock(),
      ip: clientIp(req),
      cookies: parseCookies(req.headers.get('cookie')),
      tenant: null,
      actor: null,
      setCookies: [],
    };
    let res: Response;
    try {
      const m = router.match(req.method.toUpperCase(), path);
      if (m === null) throw new ApiError('NOT_FOUND');
      if (m === 'method_not_allowed') throw new ApiError('METHOD_NOT_ALLOWED');
      ctx.params = m.params;
      await runGuards(ctx, m.route.auth);
      const out = await m.route.handler(ctx);
      res = out instanceof Response ? out : Response.json(out);
    } catch (e) {
      res = errorResponse(e);
    }
    for (const c of ctx.setCookies) res.headers.append('set-cookie', c);
    if (!res.headers.has('cache-control')) res.headers.set('cache-control', 'no-store');
    res.headers.set('x-content-type-options', 'nosniff');
    return res;
  }

  return { handle };
}

export type App = ReturnType<typeof createApp>;
