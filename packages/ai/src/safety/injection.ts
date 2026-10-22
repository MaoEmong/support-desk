/**
 * 프롬프트 인젝션 대응.
 * 1) 탐지: 지시 무시·역할 변경·프롬프트 유출 시도 패턴을 찾는다(탐지되면 정책상 이관).
 * 2) 격리: 고객 입력은 항상 구분자 태그 안에 넣고, 태그를 깨려는 문자열은 무력화한다.
 * AI 에는 어떤 실행 권한(환불·제재 해제 등)도 없으므로, 탐지를 우회하더라도 할 수 있는 일은 "문장 생성"뿐이다.
 */
import { compact } from '../text';

const PATTERNS: Array<{ id: string; re: RegExp }> = [
  { id: 'ignore_instructions', re: /(이전|위의|앞의|기존|모든|시스템)?\s*(지시|명령|지침|규칙|설정)(사항)?(을|를|은|는|들)?\s*(전부|모두|다)?\s*(무시|잊어|따르지)/ },
  { id: 'ignore_instructions_en', re: /\b(ignore|disregard|forget)\b.{0,30}\b(instruction|prompt|rule|above|previous)s?\b/i },
  { id: 'role_override', re: /(너는|넌|당신은)\s*(이제|지금부터)?\s*(관리자|운영자|개발자|시스템|admin|gm|운영진)/i },
  { id: 'role_override_en', re: /\byou are now\b|\bact as (an? )?(admin|administrator|developer|system)\b/i },
  { id: 'prompt_leak', re: /(시스템|숨겨진|숨겨 둔|내부)\s*(프롬프트|지침|지시|설정)/ },
  { id: 'prompt_leak_en', re: /\b(system prompt|hidden instructions?|reveal your (prompt|instructions))\b/i },
  { id: 'mode_switch', re: /(개발자|디버그|관리자|탈옥)\s*모드|jailbreak|\bDAN\b/i },
  { id: 'forced_answer', re: /(승인|해제|완료|처리)(됐|되었|했)다고\s*(답|말|대답|출력|안내)/ },
  { id: 'tag_breakout', re: /<\/?\s*(customer_message|system|kb_articles|instructions?)\b/i },
];

export interface InjectionCheck {
  suspected: boolean;
  matches: string[];
}

export function detectInjection(message: string): InjectionCheck {
  const normalized = message.normalize('NFKC');
  const matches = PATTERNS.filter((p) => p.re.test(normalized)).map((p) => p.id);
  // 띄어쓰기를 지운 우회("지 시 무 시")도 확인한다.
  const squeezed = compact(message);
  if (/지시(를|는)?무시|명령(을|은)?무시|프롬프트(를)?(보여|출력|알려)/.test(squeezed) && !matches.includes('squeezed')) {
    matches.push('squeezed');
  }
  return { suspected: matches.length > 0, matches };
}

/** 고객 입력을 구분자 태그 안에 넣을 때 태그 위조를 막는다. */
export function neutralizeForPrompt(text: string): string {
  return text.replace(/</g, '‹').replace(/>/g, '›');
}

export function wrapCustomerMessage(text: string): string {
  return `<customer_message>\n${neutralizeForPrompt(text)}\n</customer_message>`;
}
