/**
 * 생성 결과 안전 검사: AI 가 권한 없는 처리를 "약속"하거나 내부 지침을 흘리는 문장을 찾는다.
 * 걸리면 자동답변하지 않고 상담원에게 이관한다(초안은 상담원만 본다).
 */

const UNSAFE: Array<{ id: string; re: RegExp }> = [
  { id: 'refund_promise', re: /환불(이|을|은|를)?\s*(승인|완료|처리|진행)\s*(되었|됐|했|해\s*드리|해드리|하겠|해\s*드렸|해드렸)/ },
  { id: 'refund_promise2', re: /환불(해|하여)\s*(드리겠|드릴게|드렸)/ },
  { id: 'cancel_promise', re: /(결제|청구)(가|를|이)?\s*취소\s*(되었|됐|했|해\s*드리|해드리|하겠|해\s*드렸|해드렸)/ },
  { id: 'sanction_lift', re: /(제재|정지|이용\s*제한|밴)(가|이|를|을|는|은)?\s*(해제|풀|철회)\s*(되었|됐|했|해\s*드리|해드리|하겠|었|렸)/ },
  { id: 'recovery_promise', re: /(계정|아이템|재화)(을|를|이|가)?\s*(즉시\s*)?(복구|지급|회수)\s*(되었|됐|했|해\s*드리|해드리|하겠|해\s*드렸|해드렸|완료)/ },
  { id: 'approved_claim', re: /(요청|문의)(이|가)?\s*(승인|처리)\s*(되었습니다|됐습니다|완료되었습니다)/ },
  { id: 'prompt_leak', re: /<\/?(customer_message|kb_articles|instructions)>|platform_rules/i },
];

export interface OutputGuardResult {
  safe: boolean;
  violations: string[];
}

export function checkOutputSafety(text: string): OutputGuardResult {
  const normalized = text.normalize('NFKC');
  const violations = UNSAFE.filter((u) => u.re.test(normalized)).map((u) => u.id);
  return { safe: violations.length === 0, violations };
}
