'use client';

import type { ReactNode } from 'react';
import { CUSTOMER_ROLES, RequireRole } from '@/components/auth-guard';
import { PortalShell } from '@/components/customer/portal-shell';

export default function CustomerTicketsLayout({ children }: { children: ReactNode }) {
  return (
    <PortalShell>
      <RequireRole roles={CUSTOMER_ROLES}>{() => children}</RequireRole>
    </PortalShell>
  );
}
