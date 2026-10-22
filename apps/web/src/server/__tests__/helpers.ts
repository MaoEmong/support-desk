import { randomUUID } from 'node:crypto';
import bcrypt from 'bcryptjs';
import { stubChatResponder, type ChatResponder } from '../ai/chat';
import { createJobQueue, type AiJobQueue } from '../ai/queue';
import { createApp } from '../app';
import { loadConfig, type ServerConfig } from '../config';
import type { Role, Tenant, TenantSettings, User } from '../domain';
import { MemoryRepo } from '../repo/memory';

export const ORIGIN = 'http://localhost';
export const PASSWORD = 'password1234';
const passwordHash = bcrypt.hashSync(PASSWORD, 4);

export function testConfig(over: Partial<ServerConfig> = {}): ServerConfig {
  return { ...loadConfig({ NODE_ENV: 'test' }), bcryptRounds: 4, ...over };
}

export class Clock {
  constructor(public t = new Date('2026-10-22T00:00:00Z')) {}
  now = () => new Date(this.t);
  advance(ms: number) {
    this.t = new Date(this.t.getTime() + ms);
  }
}

export function settingsFor(tenant: Tenant, over: Partial<TenantSettings> = {}): TenantSettings {
  return {
    tenantId: tenant.id,
    displayName: tenant.name,
    logoUrl: null,
    primaryColor: '#3355ff',
    chatbotName: `${tenant.name} 봇`,
    aiSystemPrompt: '',
    aiThreshold: 0.8,
    forbiddenCategories: ['refund', 'account_theft', 'sanction'],
    approvalMode: false,
    categories: [
      { id: 'refund', label: '환불', keywords: ['환불'] },
      { id: 'account_theft', label: '계정 도용', keywords: ['해킹'] },
      { id: 'sanction', label: '제재', keywords: ['정지'] },
      { id: 'other', label: '기타', keywords: [] },
    ],
    fallbackCategory: 'other',
    autoAnswerLimit: 1,
    allowedLinkDomains: [],
    kbRevision: 0,
    updatedAt: new Date(0),
    ...over,
  };
}

export interface World {
  repo: MemoryRepo;
  clock: Clock;
  cfg: ServerConfig;
  app: ReturnType<typeof createApp>;
  tenantA: Tenant;
  tenantB: Tenant;
  users: Record<'custA1' | 'custA2' | 'agentA' | 'adminA' | 'custB1' | 'agentB' | 'adminB' | 'platform', User>;
}

export function makeWorld(opts: { cfg?: Partial<ServerConfig>; queue?: AiJobQueue; chat?: ChatResponder; repo?: MemoryRepo } = {}): World {
  const repo = opts.repo ?? new MemoryRepo();
  const clock = new Clock();
  const cfg = testConfig(opts.cfg);
  const tenantA: Tenant = { id: randomUUID(), slug: 'game', name: '픽셀게임즈', status: 'active', createdAt: new Date(0) };
  const tenantB: Tenant = { id: randomUUID(), slug: 'mkt', name: '마케팅랩', status: 'active', createdAt: new Date(0) };
  repo.state.tenants.push(tenantA, tenantB);
  repo.state.settings.push(settingsFor(tenantA), settingsFor(tenantB));
  const mk = (tenantId: string | null, role: Role, email: string, name: string): User => {
    const u: User = { id: randomUUID(), tenantId, email, passwordHash, name, role, status: 'active', createdAt: new Date(0) };
    repo.state.users.push(u);
    return u;
  };
  const users = {
    custA1: mk(tenantA.id, 'customer', 'cust1@a.test', '고객A1'),
    custA2: mk(tenantA.id, 'customer', 'cust2@a.test', '고객A2'),
    agentA: mk(tenantA.id, 'agent', 'agent@a.test', '상담A'),
    adminA: mk(tenantA.id, 'tenant_admin', 'admin@a.test', '관리A'),
    custB1: mk(tenantB.id, 'customer', 'cust1@b.test', '고객B1'),
    agentB: mk(tenantB.id, 'agent', 'agent@b.test', '상담B'),
    adminB: mk(tenantB.id, 'tenant_admin', 'admin@b.test', '관리B'),
    platform: mk(null, 'platform_admin', 'root@platform.test', '플랫폼'),
  };
  const app = createApp({
    repo,
    cfg,
    queue: opts.queue ?? createJobQueue({ pipelineVersion: 'v1' }),
    chat: opts.chat ?? stubChatResponder,
    clock: clock.now,
  });
  return { repo, clock, cfg, app, tenantA, tenantB, users };
}

export interface Res {
  status: number;
  json: any; // eslint-disable-line @typescript-eslint/no-explicit-any
  text: string;
  headers: Headers;
}

/** 쿠키 저장소를 가진 브라우저 흉내 클라이언트 */
export class Client {
  cookies = new Map<string, string>();
  constructor(
    private app: { handle(req: Request): Promise<Response> },
    public origin: string | null = ORIGIN,
  ) {}

  get csrf() {
    return this.cookies.get('sd_csrf') ?? this.cookies.get('sd_pcsrf');
  }

  async req(method: string, path: string, body?: unknown, extra: Record<string, string> = {}): Promise<Res> {
    const headers: Record<string, string> = { ...extra };
    if (this.cookies.size) headers.cookie = [...this.cookies].map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('; ');
    if (this.origin && !('origin' in extra)) headers.origin = this.origin;
    if (method !== 'GET' && this.csrf && !('x-csrf-token' in extra)) headers['x-csrf-token'] = this.csrf;
    if (body !== undefined && !('content-type' in extra)) headers['content-type'] = 'application/json';
    for (const k of Object.keys(headers)) if (headers[k] === '') delete headers[k];
    const res = await this.app.handle(
      new Request(`${ORIGIN}/api${path}`, { method, headers, body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body) }),
    );
    for (const c of res.headers.getSetCookie()) {
      const [pair] = c.split(';');
      const i = pair!.indexOf('=');
      const k = pair!.slice(0, i);
      const v = decodeURIComponent(pair!.slice(i + 1));
      if (/Max-Age=0/.test(c)) this.cookies.delete(k);
      else this.cookies.set(k, v);
    }
    const text = await res.text();
    let json: unknown = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = null;
    }
    return { status: res.status, json, text, headers: res.headers };
  }

  get = (p: string, h?: Record<string, string>) => this.req('GET', p, undefined, h);
  post = (p: string, b?: unknown, h?: Record<string, string>) => this.req('POST', p, b ?? {}, h);
  patch = (p: string, b?: unknown, h?: Record<string, string>) => this.req('PATCH', p, b ?? {}, h);
  del = (p: string, h?: Record<string, string>) => this.req('DELETE', p, undefined, h);
}

export async function loginAs(w: World, who: keyof World['users']): Promise<Client> {
  const u = w.users[who];
  const c = new Client(w.app);
  const tenant = u.tenantId === w.tenantA.id ? w.tenantA : u.tenantId === w.tenantB.id ? w.tenantB : null;
  const res = tenant
    ? await c.post(`/t/${tenant.slug}/auth/login`, { email: u.email, password: PASSWORD })
    : await c.post('/platform/auth/login', { email: u.email, password: PASSWORD });
  if (res.status !== 200) throw new Error(`login ${who} failed: ${res.status} ${res.text}`);
  return c;
}

export function parseSse(text: string) {
  return text
    .split('\n\n')
    .filter((block) => /^event: /m.test(block)) // heartbeat 주석(": keep-alive") 제외
    .map((block) => {
      const ev = /^event: (.+)$/m.exec(block)?.[1];
      const data = /^data: (.+)$/m.exec(block)?.[1];
      return { event: ev!, data: data ? JSON.parse(data) : null };
    });
}
