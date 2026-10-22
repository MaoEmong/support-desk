import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

const dateFmt = new Intl.DateTimeFormat('ko-KR', { dateStyle: 'medium', timeStyle: 'short' });
export const formatDate = (iso: string | null | undefined) => (iso ? dateFmt.format(new Date(iso)) : '-');

export const percent = (rate: number) => `${Math.round(rate * 1000) / 10}%`;

/**
 * #rrggbb 배경 위 글자색: WCAG 상대 휘도로 #ffffff / #000000 중 대비가 큰 쪽.
 * 두 대비의 곱이 21이라 큰 쪽은 항상 √21 ≈ 4.58:1 이상이다(본문 AA 4.5:1 보장).
 */
export function readableOn(hex: string): '#ffffff' | '#000000' {
  const m = /^#([0-9a-f]{6})$/i.exec(hex);
  if (!m) return '#ffffff';
  const n = parseInt(m[1], 16);
  const lin = (c: number) => {
    const s = c / 255;
    return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  const L = 0.2126 * lin((n >> 16) & 255) + 0.7152 * lin((n >> 8) & 255) + 0.0722 * lin(n & 255);
  const contrastWhite = 1.05 / (L + 0.05);
  const contrastBlack = (L + 0.05) / 0.05;
  return contrastWhite >= contrastBlack ? '#ffffff' : '#000000';
}
