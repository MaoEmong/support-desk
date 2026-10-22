import type { ServerConfig } from '../config';
import { ApiError } from '../errors';
import type { Repo } from '../repo/types';

/**
 * 로그인 시도 제한(DB 기록 기반이라 다중 인스턴스에서도 동작).
 * 계정 키(테넌트+이메일)와 IP 키 두 축으로 최근 실패 횟수를 센다.
 */
export const accountKey = (tenantId: string | null, email: string) => `acct:${tenantId ?? 'platform'}:${email.toLowerCase()}`;
export const ipKey = (ip: string | null) => (ip ? `ip:${ip}` : null);

export interface AttemptKeys {
  account: string;
  ip: string | null;
}

export async function assertNotThrottled(repo: Repo, cfg: ServerConfig, now: Date, keys: AttemptKeys) {
  const since = new Date(now.getTime() - cfg.loginWindowMs);
  const headers = { 'retry-after': String(Math.ceil(cfg.loginWindowMs / 1000)) };
  if ((await repo.countFailedAttempts(keys.account, since)) >= cfg.loginMaxFailuresPerAccount) {
    throw new ApiError('TOO_MANY_ATTEMPTS', undefined, { scope: 'account' }, headers);
  }
  if (keys.ip && (await repo.countFailedAttempts(keys.ip, since)) >= cfg.loginMaxFailuresPerIp) {
    throw new ApiError('TOO_MANY_ATTEMPTS', undefined, { scope: 'ip' }, headers);
  }
}

export async function recordAttempt(repo: Repo, now: Date, keys: AttemptKeys, succeeded: boolean, ip: string | null) {
  await repo.recordLoginAttempt({ key: keys.account, succeeded, ip, createdAt: now });
  if (keys.ip) await repo.recordLoginAttempt({ key: keys.ip, succeeded, ip, createdAt: now });
}
