import type { HTMLAttributes, ReactNode } from 'react';
import { cn } from '@/lib/utils';

export function Card({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn('rounded-lg border border-border bg-card p-4 shadow-sm sm:p-5', className)} {...props} />;
}

export function PageHeader({ title, description, actions }: { title: ReactNode; description?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="mb-5 flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
      <div className="min-w-0 [overflow-wrap:anywhere]">
        <h1 className="min-w-0 text-xl font-bold [overflow-wrap:anywhere] sm:text-2xl">{title}</h1>
        {description && <p className="mt-1 text-sm text-muted-foreground">{description}</p>}
      </div>
      {actions && <div className="flex flex-wrap gap-2">{actions}</div>}
    </div>
  );
}

type Tone = 'neutral' | 'info' | 'success' | 'warning' | 'danger' | 'brand';
const tones: Record<Tone, string> = {
  neutral: 'bg-muted text-foreground border-border',
  info: 'bg-info-soft text-info border-info/30',
  success: 'bg-success-soft text-success border-success/30',
  warning: 'bg-warning-soft text-warning border-warning/30',
  danger: 'bg-danger-soft text-danger border-danger/30',
  brand: 'bg-brand text-brand-foreground border-transparent',
};

export function Badge({ tone = 'neutral', className, children, ...props }: HTMLAttributes<HTMLSpanElement> & { tone?: Tone }) {
  return (
    // 짧은 배지는 한 줄 그대로, 긴 값(테넌트 분류명 등)만 칸 안에서 줄바꿈
    <span
      className={cn(
        'inline-flex max-w-full items-center gap-1 whitespace-normal rounded-full border px-2 py-0.5 text-xs font-medium [overflow-wrap:anywhere]',
        tones[tone],
        className,
      )}
      {...props}
    >
      {children}
    </span>
  );
}

/**
 * 안내 박스. danger는 항상 role=alert. 그 밖의 톤은 기본으로 live region이 아니며(정적 안내가 화면 진입마다 읽히지 않게),
 * 사용자 동작의 결과처럼 즉시 알려야 할 때만 live로 role=status를 붙인다.
 */
export function Alert({
  tone = 'info',
  title,
  children,
  className,
  live,
}: {
  tone?: Exclude<Tone, 'brand' | 'neutral'>;
  title?: ReactNode;
  children?: ReactNode;
  className?: string;
  live?: boolean;
}) {
  const role = tone === 'danger' ? 'alert' : live ? 'status' : undefined;
  return (
    <div role={role} className={cn('rounded-md border px-4 py-3 text-sm [overflow-wrap:anywhere]', tones[tone], className)}>
      {title && <p className="font-semibold">{title}</p>}
      {children && <div className={title ? 'mt-1' : undefined}>{children}</div>}
    </div>
  );
}

export function Spinner({ label = '불러오는 중' }: { label?: string }) {
  return (
    <span role="status" className="inline-flex items-center gap-2 text-sm text-muted-foreground">
      <span aria-hidden className="h-4 w-4 animate-spin rounded-full border-2 border-border border-t-brand" />
      {label}
    </span>
  );
}

export type { Tone };
