/**
 * 시연용 데모 계정 9개(순수 데이터, 비밀번호 없음).
 * seed·계정 전환 스크립트·로그인 화면 빠른 입력 버튼이 이 표 하나만 쓴다.
 * 비밀번호는 서버 seed 환경(SEED_PASSWORD, 기본 demo1234)에서만 정해지고 여기에 두지 않는다.
 * 의존성 없는 독립 모듈(@support/db가 새 의존성 없이 소스 경로로 읽는다). role 값은 RoleSchema와 같다.
 */
export interface DemoAccount {
  /** 고객센터 테넌트 slug. 플랫폼 관리자는 null */
  tenantSlug: string | null;
  role: 'customer' | 'agent' | 'tenant_admin' | 'platform_admin';
  email: string;
  /** 화면 표시용 이름 */
  label: string;
}

export const DEMO_ACCOUNTS: readonly DemoAccount[] = [
  { tenantSlug: 'pixelforge', role: 'customer', email: 'c1@pf.test', label: '픽셀포지 고객 1' },
  { tenantSlug: 'pixelforge', role: 'customer', email: 'c2@pf.test', label: '픽셀포지 고객 2' },
  { tenantSlug: 'pixelforge', role: 'agent', email: 'agent@pf.test', label: '픽셀포지 상담원' },
  { tenantSlug: 'pixelforge', role: 'tenant_admin', email: 'admin@pf.test', label: '픽셀포지 관리자' },
  { tenantSlug: 'mailpulse', role: 'customer', email: 'c1@mp.test', label: '메일펄스 고객 1' },
  { tenantSlug: 'mailpulse', role: 'customer', email: 'c2@mp.test', label: '메일펄스 고객 2' },
  { tenantSlug: 'mailpulse', role: 'agent', email: 'agent@mp.test', label: '메일펄스 상담원' },
  { tenantSlug: 'mailpulse', role: 'tenant_admin', email: 'admin@mp.test', label: '메일펄스 관리자' },
  { tenantSlug: null, role: 'platform_admin', email: 'admin@platform.test', label: '플랫폼 관리자' },
];
