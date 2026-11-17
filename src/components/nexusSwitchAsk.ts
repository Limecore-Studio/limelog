// v1.21.1 (LimeLog#138) — the question "Continue with Nexus" asks when NCC is
// signed in to a different account than the one this device's data belongs
// to. Shared by the sign-in screen (FirstLaunchAuth) and the Settings card
// (NexusSyncCard), which both offer the button. The loss sentences are the
// sign-out confirm's, so the three say the same about what goes.

import type { TFunction } from 'i18next';
import type { Confirm } from '@/components/confirmContext';
import type { HeldAccountData } from '@/store/nexusStore';
import { useLogStore } from '@/store/logStore';

export async function askNexusSwitch(
  held: HeldAccountData & { nexusEmail: string | null },
  { t, confirm, syncEnabled }: { t: TFunction; confirm: Confirm; syncEnabled: boolean },
): Promise<boolean> {
  const parts = [
    held.email ? t('auth.guestHeldEmail', { email: held.email }) : t('auth.guestHeldAccount'),
    held.nexusEmail ? t('auth.nexusOtherEmail', { email: held.nexusEmail }) : t('auth.nexusOtherAccount'),
    t('auth.nexusOtherRemove'),
  ];
  if (held.unsynced > 0) parts.push(t('sync.signOutUnsynced', { count: held.unsynced }));
  if (!syncEnabled && useLogStore.getState().sessionLogs.length > 0) parts.push(t('sync.signOutSyncOff'));
  // Loaded here rather than at launch (LimeLog#70), as the guest confirm does.
  const { listPhotos } = await import('@/lib/progressPhotos');
  const photos = listPhotos().length;
  if (photos > 0) parts.push(t('sync.signOutPhotos', { count: photos }));
  return confirm({ title: t('auth.nexusOtherTitle'), message: parts.join(' '), confirmLabel: t('auth.nexusOtherConfirm') });
}
