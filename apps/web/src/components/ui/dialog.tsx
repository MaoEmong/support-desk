'use client';

import * as DialogPrimitive from '@radix-ui/react-dialog';
import { X } from 'lucide-react';
import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';

export const Dialog = DialogPrimitive.Root;
export const DialogTrigger = DialogPrimitive.Trigger;
export const DialogClose = DialogPrimitive.Close;

export function DialogContent({ title, description, children, className }: { title: ReactNode; description?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <DialogPrimitive.Portal>
      <DialogPrimitive.Overlay className="fixed inset-0 z-40 bg-black/50" />
      <DialogPrimitive.Content
        className={cn(
          'fixed left-1/2 top-1/2 z-50 max-h-[90dvh] w-[calc(100vw-2rem)] max-w-lg -translate-x-1/2 -translate-y-1/2 overflow-y-auto rounded-lg border border-border bg-card p-5 shadow-xl',
          className,
        )}
      >
        <DialogPrimitive.Title className="pr-8 text-lg font-semibold">{title}</DialogPrimitive.Title>
        {description ? (
          <DialogPrimitive.Description className="mt-1 text-sm text-muted-foreground">{description}</DialogPrimitive.Description>
        ) : (
          <DialogPrimitive.Description className="sr-only">{title}</DialogPrimitive.Description>
        )}
        <div className="mt-4">{children}</div>
        <DialogPrimitive.Close className="absolute right-3 top-3 rounded p-1.5 text-muted-foreground hover:bg-muted" aria-label="닫기">
          <X className="h-4 w-4" aria-hidden />
        </DialogPrimitive.Close>
      </DialogPrimitive.Content>
    </DialogPrimitive.Portal>
  );
}
