// In-app replacement for window.confirm().
//
// Ported from nexus-command-center's src/components/ConfirmDialog.tsx (NC-6),
// where the reasoning was worked out: on Android WebView the native dialog is
// the OS dialog, so its buttons come out in the *OS* language rather than the
// app's — someone running LimeLog in Hindi got a translated message with English
// "OK / Cancel". It also renders LTR under dir="rtl", shows the package name as
// its title, and blocks the JS thread. It was the last place the ten-language
// and RTL work visibly leaked.
//
// Two of the six call sites this replaces mattered more than the rest: the
// account-deletion confirmations added with L-8. An irreversible erasure that
// spans all three apps should not be gated behind a dialog titled with the
// package name.
//
// The API is deliberately promise-based and shaped like the thing it replaces,
// so a call site changes from
//     if (!confirm(msg)) return;
// to
//     if (!(await confirm({ message: msg }))) return;
// and nothing else about the surrounding logic moves.
//
// The context, the hook and the option type live in ./confirmContext so this
// module exports only a component — see the note there.

import { useCallback, useMemo, useRef, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { ConfirmContext, type Confirm, type ConfirmOptions } from './confirmContext';
import './ConfirmDialog.css';

export function ConfirmProvider({ children }: { children: ReactNode }) {
  const { t } = useTranslation();
  const [pending, setPending] = useState<ConfirmOptions | null>(null);
  const resolver = useRef<((v: boolean) => void) | null>(null);

  const confirm = useCallback<Confirm>((opts) => {
    setPending(opts);
    return new Promise<boolean>((resolve) => {
      resolver.current = resolve;
    });
  }, []);

  const settle = useCallback((value: boolean) => {
    resolver.current?.(value);
    resolver.current = null;
    setPending(null);
  }, []);

  const value = useMemo(() => confirm, [confirm]);

  return (
    <ConfirmContext.Provider value={value}>
      {children}
      {pending && (
        <div
          className="cfd-backdrop"
          role="dialog"
          aria-modal="true"
          // Dismissing by backdrop is a cancel, matching the native dialog.
          onClick={() => settle(false)}
        >
          <div className="cfd-card" onClick={(e) => e.stopPropagation()}>
            {pending.title && <h2 className="cfd-title">{pending.title}</h2>}
            <p className="cfd-message">{pending.message}</p>
            <div className="cfd-actions">
              {!pending.notice && (
                <button className="cfd-btn" onClick={() => settle(false)}>
                  {pending.cancelLabel ?? t('common.cancel')}
                </button>
              )}
              <button
                className={`cfd-btn cfd-btn--${pending.destructive === false ? 'primary' : 'danger'}`}
                onClick={() => settle(true)}
                autoFocus
              >
                {pending.confirmLabel ?? t('common.confirm')}
              </button>
            </div>
          </div>
        </div>
      )}
    </ConfirmContext.Provider>
  );
}
