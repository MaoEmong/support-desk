import type { ReactNode } from 'react';
import { TenantProvider } from '@/components/tenant-context';

export default async function TenantLayout({ children, params }: { children: ReactNode; params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  return <TenantProvider slug={decodeURIComponent(slug)}>{children}</TenantProvider>;
}
