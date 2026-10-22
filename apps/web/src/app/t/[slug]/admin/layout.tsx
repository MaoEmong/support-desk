'use client';

import type { ReactNode } from 'react';
import { AdminShell } from '@/components/admin/admin-shell';
import { RequireRole, STAFF_ROLES } from '@/components/auth-guard';

export default function AdminLayout({ children }: { children: ReactNode }) {
  return <RequireRole roles={STAFF_ROLES}>{(me) => <AdminShell me={me}>{children}</AdminShell>}</RequireRole>;
}
