import type { Metadata, Viewport } from 'next';
import type { ReactNode } from 'react';
import './globals.css';
import { Providers } from './providers';

export const metadata: Metadata = {
  title: { default: 'Support Desk', template: '%s · Support Desk' },
  description: '멀티테넌트 AI 고객지원 헬프데스크',
};

export const viewport: Viewport = { width: 'device-width', initialScale: 1 };

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="ko">
      <body className="min-h-dvh">
        <a href="#main" className="sr-only focus:not-sr-only focus:fixed focus:left-2 focus:top-2 focus:z-50 focus:rounded focus:bg-card focus:px-3 focus:py-2">
          본문으로 건너뛰기
        </a>
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
