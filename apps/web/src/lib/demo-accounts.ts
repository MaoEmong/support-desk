import { DEMO_ACCOUNTS, type DemoAccount } from '@support/contracts';

/**
 * 데모 계정 비밀번호(공개 데모값). 시드 기본값과 같다.
 * SEED_PASSWORD로 다른 비밀번호를 쓰는 환경에서는 데모 버튼을 끌 것(NEXT_PUBLIC_DEMO_ACCOUNTS를 설정하지 않음).
 */
export const DEMO_PASSWORD = 'demo1234';

/**
 * 데모 로그인 버튼 표시 여부. 정확히 '1'일 때만 켠다(기본 숨김).
 * NEXT_PUBLIC_ 값은 공개값이고 build 시점에 번들에 고정된다. 함수로 분리해 E2E에서 값별 판정을 단언한다.
 */
export function isDemoLoginEnabled(value: string | undefined): boolean {
  return value === '1';
}

/** 현재 화면용 데모 계정: 테넌트 화면은 그 slug의 계정, 플랫폼 화면(slug null)은 tenantSlug null 계정만 */
export function demoAccountsFor(slug: string | null): DemoAccount[] {
  return DEMO_ACCOUNTS.filter((a) => a.tenantSlug === slug);
}

/** 화면에서 실제로 보여줄 데모 계정(비활성이면 빈 배열). process.env 접근은 Next가 build 때 치환한다. */
export function visibleDemoAccounts(slug: string | null): DemoAccount[] {
  return isDemoLoginEnabled(process.env.NEXT_PUBLIC_DEMO_ACCOUNTS) ? demoAccountsFor(slug) : [];
}
