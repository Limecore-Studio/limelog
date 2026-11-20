// Context and hook for ConfirmDialog, kept out of the .tsx deliberately.
//
// react-refresh/only-export-components fires when a module exports both a
// component and something else, because Fast Refresh can then only reload half
// of it. LimeLog lints at --max-warnings 0, so the rule's own advice applies:
// the non-component exports live here and ConfirmDialog.tsx exports only the
// provider.

import { createContext, useContext } from 'react';

export interface ConfirmOptions {
  message: string;
  /** Optional heading above the message. */
  title?: string;
  /** Defaults to common.confirm. */
  confirmLabel?: string;
  /** Defaults to common.cancel. */
  cancelLabel?: string;
  /** Renders the confirm button in the danger colour. Default true — every
   *  current caller guards a destructive action. */
  destructive?: boolean;
  /** v1.22 — a notice: one button (confirmLabel), no cancel. */
  notice?: boolean;
}

export type Confirm = (opts: ConfirmOptions) => Promise<boolean>;

export const ConfirmContext = createContext<Confirm | null>(null);

export function useConfirm(): Confirm {
  const ctx = useContext(ConfirmContext);
  if (!ctx) throw new Error('useConfirm must be used inside <ConfirmProvider>');
  return ctx;
}
