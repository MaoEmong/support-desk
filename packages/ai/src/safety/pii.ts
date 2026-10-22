/** 운영 로그용 PII 마스킹. 업무 이력(ai_runs)이 아니라 콘솔·APM 로그에 남기기 전에 쓴다. */

const RULES: Array<{ name: string; re: RegExp; mask: (m: string) => string }> = [
  {
    name: 'email',
    re: /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g,
    mask: (m) => {
      const [local = '', domain = ''] = m.split('@');
      return `${local.slice(0, 1)}***@${domain}`;
    },
  },
  // 주민등록번호(6-7)
  { name: 'rrn', re: /\b\d{6}[-\s]?[1-4]\d{6}\b/g, mask: () => '******-*******' },
  // 카드번호(13~19자리, 구분자 허용)
  {
    name: 'card',
    re: /\b(?:\d[ -]?){12,18}\d\b/g,
    mask: (m) => {
      const digits = m.replace(/\D/g, '');
      return `****-****-****-${digits.slice(-4)}`;
    },
  },
  // 휴대폰·전화번호
  {
    name: 'phone',
    re: /\b(?:\+?82[-\s]?)?0?1[016789][-\s.]?\d{3,4}[-\s.]?\d{4}\b|\b0\d{1,2}[-\s.]\d{3,4}[-\s.]\d{4}\b/g,
    mask: (m) => m.replace(/\d(?=[\d\s.-]{4})/g, '*'),
  },
  // 비밀번호를 같이 적은 경우: "비밀번호 abc123", "password: xxx"
  {
    name: 'password',
    re: /((?:비밀번호|비번|password|pw)\s*[:=은는이가]?\s*)(\S+)/gi,
    mask: (m) => m.replace(/(\s*[:=은는이가]?\s*)(\S+)$/i, '$1********'),
  },
  { name: 'ipv4', re: /\b(?:\d{1,3}\.){3}\d{1,3}\b/g, mask: (m) => m.replace(/\.\d{1,3}$/, '.***') },
];

export function maskPII(text: string): string {
  let out = text;
  for (const rule of RULES) out = out.replace(rule.re, (m) => rule.mask(m));
  return out;
}

/** 객체를 로그로 남기기 전에 문자열 필드를 모두 마스킹한다. */
export function maskDeep<T>(value: T): T {
  if (typeof value === 'string') return maskPII(value) as T;
  if (Array.isArray(value)) return value.map((v) => maskDeep(v)) as T;
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, maskDeep(v)])) as T;
  }
  return value;
}
