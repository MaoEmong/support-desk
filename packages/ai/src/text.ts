/** 검색·키워드 매칭용 텍스트 유틸. 형태소 분석기 없이 한국어를 다루기 위해 한글은 음절 bigram 으로 쪼갠다. */

const HANGUL = /[가-힣]/;

export function normalize(text: string): string {
  return text.normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim();
}

/** 공백 제거 버전: "환불 해주세요" 와 "환불해주세요" 를 같은 키워드로 잡기 위해 쓴다. */
export function compact(text: string): string {
  return normalize(text).replace(/[\s\p{P}\p{S}]+/gu, '');
}

/**
 * 토큰화: 문자/숫자 덩어리로 나눈 뒤
 * - 한글 덩어리는 음절 bigram (1음절이면 그대로)
 * - 그 외(영문·숫자)는 덩어리 그대로
 */
export function tokenize(text: string): string[] {
  const chunks = normalize(text).match(/[\p{L}\p{N}]+/gu) ?? [];
  const out: string[] = [];
  for (const chunk of chunks) {
    if (HANGUL.test(chunk)) {
      // 한글과 영숫자가 섞인 덩어리는 문자 종류 경계에서 다시 나눈다.
      const parts = chunk.match(/[가-힣]+|[^가-힣]+/g) ?? [];
      for (const part of parts) {
        if (!HANGUL.test(part)) {
          if (part.length > 1) out.push(part);
          continue;
        }
        if (part.length === 1) {
          out.push(part);
          continue;
        }
        for (let i = 0; i < part.length - 1; i++) out.push(part.slice(i, i + 2));
      }
    } else if (chunk.length > 1) {
      out.push(chunk);
    }
  }
  return out;
}

/** 키워드가 본문에 포함되는지(공백·문장부호 무시). */
export function containsKeyword(compactText: string, keyword: string): boolean {
  const k = compact(keyword);
  return k.length > 0 && compactText.includes(k);
}

export function excerpt(text: string, max = 160): string {
  const plain = text
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/[*_`#>]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return plain.length <= max ? plain : `${plain.slice(0, max - 1)}…`;
}
