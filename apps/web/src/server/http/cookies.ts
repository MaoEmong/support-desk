export function parseCookies(header: string | null): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    const v = part.slice(i + 1).trim();
    if (!k || k in out) continue;
    try {
      out[k] = decodeURIComponent(v);
    } catch {
      out[k] = v;
    }
  }
  return out;
}

export interface CookieOptions {
  httpOnly?: boolean;
  secure?: boolean;
  sameSite?: 'Lax' | 'Strict';
  path?: string;
  /** 초. 0이면 즉시 삭제 */
  maxAge?: number;
}

export function serializeCookie(name: string, value: string, o: CookieOptions = {}): string {
  const parts = [`${name}=${encodeURIComponent(value)}`, `Path=${o.path ?? '/'}`, `SameSite=${o.sameSite ?? 'Lax'}`];
  if (o.httpOnly) parts.push('HttpOnly');
  if (o.secure) parts.push('Secure');
  if (o.maxAge !== undefined) {
    parts.push(`Max-Age=${Math.max(0, Math.floor(o.maxAge))}`);
    if (o.maxAge <= 0) parts.push('Expires=Thu, 01 Jan 1970 00:00:00 GMT');
  }
  return parts.join('; ');
}
