import { useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { useNexusStore } from '@/store/nexusStore';
import { useConfirm } from '@/components/confirmContext';

// v1.22 (limecore#95) — an account signed in over data logged as a guest. On a
// shared device that may be someone else's training and health data, so it is
// not uploaded or added to the account until the person says so (the take-up
// waits in accountOwner.ts). The app's own confirm sheet, asked twice for
// Remove: dismissing the first sheet is not a delete, it only asks again.
export function GuestDataPrompt() {
  const { t } = useTranslation();
  const confirm = useConfirm();
  const ask = useNexusStore((s) => s.guestDataAsk);
  const answer = useNexusStore((s) => s.answerGuestData);
  const asking = useRef<string | null>(null);

  useEffect(() => {
    if (!ask || asking.current === ask.userId) return;
    asking.current = ask.userId;
    void (async () => {
      const { held } = ask;
      const counts = t('guestData.counts', { workouts: held.workouts, measurements: held.measurements, photos: held.photos });
      for (;;) {
        const keep = await confirm({
          title: t('guestData.title'),
          message: `${t('guestData.body', { email: ask.email ?? t('guestData.thisAccount') })}\n\n${counts}`,
          confirmLabel: t('guestData.keep'),
          cancelLabel: t('guestData.notMine'),
          destructive: false,
        });
        if (keep) {
          answer(true);
          break;
        }
        const remove = await confirm({
          title: t('guestData.removeTitle'),
          message: t('guestData.removeBody'),
          confirmLabel: t('common.delete'),
          cancelLabel: t('common.back'),
        });
        if (!remove) continue;
        if (answer(false)) break;
        // Part of it could not be deleted: the question stands.
        await confirm({ message: t('guestData.removeFailed'), confirmLabel: t('common.continue'), destructive: false });
      }
      asking.current = null;
    })();
  }, [ask, answer, confirm, t]);

  return null;
}
