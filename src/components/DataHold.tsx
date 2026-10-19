import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui';
import { useConfirm } from '@/components/confirmContext';
import { useNexusStore } from '@/store/nexusStore';
import { proceedWithoutOwnerRecord, rereadOwnerRecord } from '@/lib/accountOwner';
import type { DataReadiness } from '@/lib/dataReady';
import './DataHold.css';

/** How long "Getting your data ready…" shows before it offers a way out. */
const SLOW_MS = 10_000;

// v1.18.1 (LimeLog#94) — shown by App.tsx in place of every view while it is
// not known whose the local data is, or it is still the previous account's
// (lib/dataReady.ts), so that account's data is never on screen for the next.
//   - 'pending': the owner record is still being read; this goes on its own
//     when the take-up after it runs. Past SLOW_MS (a read that does not
//     answer) it says so and offers Retry now (reads again) and Sign out,
//     which clears the device without setting anything aside, as the owner
//     is not known (nexusStore.signOut). With no account signed in, Continue
//     instead: nothing is cleared (a guest's data may exist nowhere else),
//     and the launch carries on as if no owner was recorded.
//     The known-owner case with no account ('held') is the sign-in screen's,
//     with its guest question (LimeLog#91), not this screen's.
//   - 'waiting': the previous account's data could not be cleared. Retry now
//     runs the take-up again (the same action as in Settings); Sign out
//     leaves the account, as it does from Settings.
export function DataHold({ state }: { state: Exclude<DataReadiness, 'ready' | 'held'> }) {
  const { t } = useTranslation();
  const confirm = useConfirm();
  const retryPending = useNexusStore((s) => s.retryPending);
  const signOut = useNexusStore((s) => s.signOut);
  const signedIn = useNexusStore((s) => Boolean(s.userId));
  const [busy, setBusy] = useState(false);
  const [slow, setSlow] = useState(false);

  useEffect(() => {
    if (state !== 'pending') return;
    const id = setTimeout(() => setSlow(true), SLOW_MS);
    return () => clearTimeout(id);
  }, [state]);

  async function run(action: () => Promise<unknown>) {
    setBusy(true);
    try {
      await action();
    } catch {
      // None of these throws for a network it cannot reach; nothing else may
      // escape the click handler.
    } finally {
      setBusy(false);
    }
  }

  const leave = () =>
    signedIn
      ? void run(async () => {
          if (await confirm({ message: t('sync.signOutConfirm'), confirmLabel: t('sync.signOut') })) await signOut();
        })
      : proceedWithoutOwnerRecord();

  const actions = (retry: () => Promise<unknown>) => (
    <div className="data-hold__actions">
      <Button variant="primary" size="sm" disabled={busy} onClick={() => void run(retry)}>
        {busy ? t('sync.retrying') : t('sync.retryNow')}
      </Button>
      <Button variant="ghost" size="sm" disabled={busy} onClick={leave}>
        {signedIn ? t('sync.signOut') : t('common.continue')}
      </Button>
    </div>
  );

  if (state === 'pending') {
    return (
      <div className="fla-splash data-hold" role="status">
        <span className="data-hold__spinner" aria-hidden="true" />
        <div className="fla-splash-text">{t('sync.gettingReady')}</div>
        {slow && (
          <>
            <p className="data-hold__text">{t('sync.gettingReadySlow')}</p>
            {actions(() => rereadOwnerRecord())}
          </>
        )}
      </div>
    );
  }

  return (
    <div className="fla-splash data-hold" role="alert">
      <p className="data-hold__text">
        {t('sync.waitingForClear')} {t('sync.waitingOpens')}
      </p>
      {actions(retryPending)}
    </div>
  );
}
