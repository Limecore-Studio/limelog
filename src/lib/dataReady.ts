// v1.18.1 (LimeLog#94) — whether the screens may show the local data. The
// drain and the recovery pull already wait until the data is the signed-in
// account's (accountOwner.ts, LimeLog#88/#92), but the screens render the
// stores as they are, so while a take-over waited the next account was shown
// the previous account's logs, body metrics, photos and records. The app
// shell (App.tsx) holds the views until this says 'ready'. One place, not per
// screen.
//
//   - the owner record is still being read (LimeLog#92): 'pending', signed in
//     or not. It may name another account; the take-up runs when it answers;
//   - an account is signed in:
//       - the record names it: 'ready'. This covers the same account again
//         and an offline launch on its own unverified session;
//       - no owner recorded: 'ready'. Nothing on the device is another
//         account's; the take-up runs before the account is set (nexusStore),
//         so this is the first-sign-in path;
//       - the record names another account: 'waiting'. Its clear failed (sync
//         shows sync.waitingForClear); Retry now runs the take-up again;
//   - no account signed in (guest, signed out, a sign-up awaiting its code):
//       - no owner recorded: 'ready' (a guest's data);
//       - an owner recorded: 'held'. The data is that account's (its session
//         ended without a sign-out, or a sign-out's clear failed), so the
//         sign-in screen is shown, guest mode or not: signing in as it keeps
//         the data, "Continue as guest" asks before clearing it (LimeLog#91).
//
// Reactive through the nexus store: every take-up (takeUp in nexusStore,
// including the one after a late mirror read and Retry now), sign-out and
// "Continue as guest" ends with a store update, which re-runs the selector.
import { useNexusStore } from '@/store/nexusStore';
import { ownerRecordPending, readOwner } from './accountOwner';

export type DataReadiness = 'ready' | 'pending' | 'waiting' | 'held';

export function dataReadiness(userId: string | null): DataReadiness {
  if (ownerRecordPending()) return 'pending';
  const owner = readOwner();
  if (owner === null || owner === userId) return 'ready';
  return userId ? 'waiting' : 'held';
}

export function useDataReady(): DataReadiness {
  return useNexusStore((s) => dataReadiness(s.userId));
}

/** v1.18.1 (LimeLog#94) — whether App.tsx shows the sign-in screen (once
 *  launch has resolved). Keyed on the account id, which is set only with a
 *  session: a sign-up waiting for its code sets the email alone, and stays
 *  on the sign-in screen and its code step. With no account signed in and
 *  the data still an account's ('held'), guest mode or not. */
export function showsSignIn(o: {
  userId: string | null;
  sessionUnverified: boolean;
  guestMode: boolean;
  configured: boolean;
  readiness: DataReadiness;
}): boolean {
  return !o.userId && o.configured && (o.readiness === 'held' || (!o.sessionUnverified && !o.guestMode));
}
