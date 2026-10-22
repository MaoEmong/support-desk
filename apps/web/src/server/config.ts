/** 서버 런타임 설정. 테스트는 createApp에 부분 덮어쓰기를 넘긴다. */
export interface ServerConfig {
  /** 세션 쿠키에 Secure를 붙일지(운영 true) */
  secureCookies: boolean;
  /** 마지막 활동 후 세션 유효 시간 */
  sessionIdleMs: number;
  /** 로그인 후 절대 만료 시간 */
  sessionAbsoluteMs: number;
  /** lastSeenAt 갱신 최소 간격(쓰기 부하 감소) */
  sessionTouchIntervalMs: number;
  bcryptRounds: number;
  /** 계정 키(테넌트+이메일) 기준 실패 허용 횟수 / 창 */
  loginMaxFailuresPerAccount: number;
  /** IP 기준 실패 허용 횟수 / 창 */
  loginMaxFailuresPerIp: number;
  loginWindowMs: number;
  /** Origin 검사 허용 목록. 비어 있으면 요청 Host와 같은 origin만 허용 */
  allowedOrigins: string[];
  aiMode: 'mock' | 'claude';
  pipelineVersion: string;
  maxPageSize: number;
  /** SSE heartbeat 간격(프록시 유휴 끊김 방지) */
  sseHeartbeatMs: number;
}

const num = (v: string | undefined, d: number) => {
  const n = v === undefined ? NaN : Number(v);
  return Number.isFinite(n) && n > 0 ? n : d;
};

export function loadConfig(env: Record<string, string | undefined> = process.env): ServerConfig {
  const aiMode = env.AI_MODE === 'claude' ? 'claude' : 'mock';
  return {
    secureCookies: env.NODE_ENV === 'production' && env.INSECURE_COOKIES !== '1',
    sessionIdleMs: num(env.SESSION_IDLE_MINUTES, 120) * 60_000,
    sessionAbsoluteMs: num(env.SESSION_ABSOLUTE_HOURS, 24 * 7) * 3_600_000,
    sessionTouchIntervalMs: 60_000,
    bcryptRounds: num(env.BCRYPT_ROUNDS, 12),
    loginMaxFailuresPerAccount: num(env.LOGIN_MAX_FAILURES, 5),
    loginMaxFailuresPerIp: num(env.LOGIN_MAX_FAILURES_PER_IP, 30),
    loginWindowMs: num(env.LOGIN_WINDOW_MINUTES, 15) * 60_000,
    allowedOrigins: (env.APP_ORIGINS ?? env.APP_URL ?? '')
      .split(',')
      .map((s) => s.trim().replace(/\/$/, ''))
      .filter(Boolean),
    aiMode,
    pipelineVersion: env.AI_PIPELINE_VERSION ?? 'v1',
    maxPageSize: 100,
    sseHeartbeatMs: 15_000,
  };
}
