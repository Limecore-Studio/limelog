// v1.18.1 (LimeLog#88) — everything on this device that belongs to the
// signed-in account, cleared in one place. Used by an explicit sign-out
// (nexusStore.signOut, LimeLog#81/#82) and by a different account's session
// arriving (accountOwner.ts), so the two lists cannot drift apart. Moved here
// from signOut unchanged.
//
// An erase (dataRights.wipeAllLocalData) removes more, by prefix, on purpose:
// see there.
import { clear as outboxClear } from '@/lib/outbox';
import { clearEntitlement } from '@/lib/entitlement';
import { releaseOnboardingOnSignOut } from '@/lib/onboarding';
import { forgetReferralAskedLocally } from '@/lib/referralSource';
import { forgetLastAppOpen } from '@/lib/appOpens';
import { useLogStore } from '@/store/logStore';
import { useBodyMetricsStore } from '@/store/bodyMetricsStore';
import { DEFAULT_PREFS as DEFAULT_BODY_METRICS_PREFS } from '@/types/bodyMetrics';

// useProgramStore is intentionally NOT wiped — programs / exercises /
// workout templates are tool configuration, not history, and a global
// wipe would clobber the user's custom builtin overrides + force a
// re-seed of BUILTIN_EXERCISES that would lose their tweaks. The
// per-user scope of programs is tracked as a v1.3 design item.
//
// v1.18.1 (LimeLog#88) — returns whether every step succeeded. Each step still
// runs when one before it fails (sign-out clears as much as it can), but an
// account switch takes the data up only on `true` (accountOwner.ts). A helper
// returning nothing counts as done; only an explicit `false` is a failure.
export function wipeAccountLocalData(): boolean {
  let ok = true;
  const step = (done: boolean | void) => {
    if (done === false) ok = false;
  };
  // v1.2 — the outbox goes first. Anything not yet sent is forfeit rather
  // than sent under the next signed-in account. Matches StudyDesk's
  // sign-out contract.
  step(outboxClear());
  // v1.12 Item 5 — the supporter entitlement is cached locally so a perk
  // survives being offline. That cache is per-account, so it goes with
  // everything else: leaving it would hand the next signed-in account on a
  // shared device someone else's paid perk.
  step(clearEntitlement());
  // v1.2.1 — AUDIT-LL-FSG-2: the personal-data stores, so the next signed-in
  // account on a shared device doesn't inherit the previous one's workout
  // history, bodyweight log, or progress photos in the UI. Cloud-side data
  // stays scoped to its own user_id; this only addresses what is on the
  // device. Order doesn't matter — each step both clears the in-memory
  // zustand state and removes the underlying localStorage key so a reload
  // doesn't re-hydrate.
  try {
    localStorage.removeItem('wt_session_logs');
    localStorage.removeItem('wt_jump_logs');
    localStorage.removeItem('wt_stall_flags');
    useLogStore.setState({ sessionLogs: [], jumpLogs: [], stallFlags: [] });
  } catch (e) {
    ok = false;
    console.warn('[nexus] log-store wipe failed:', e);
  }
  try {
    localStorage.removeItem('limelog-body-metrics');
    localStorage.removeItem('limelog-body-metrics-prefs');
    // bodyMetricsStore reads DEFAULT_PREFS from types/bodyMetrics on the
    // next mount; the setState below restores in-memory state to that
    // baseline so an already-mounted BodyMetricsPanel re-renders empty
    // immediately rather than holding the previous values.
    useBodyMetricsStore.setState({ metrics: [], prefs: DEFAULT_BODY_METRICS_PREFS });
  } catch (e) {
    ok = false;
    console.warn('[nexus] body-metrics wipe failed:', e);
  }
  try {
    localStorage.removeItem('limelog-progress-photos');
  } catch (e) {
    ok = false;
    console.warn('[nexus] progress-photos wipe failed:', e);
  }
  // v1.18.1 (LimeLog#82) — the per-person flags go too, as an erase removes
  // them (dataRights.wipeAllLocalData). Each helper says why it is safe:
  // the training goal is display-only, the referral mirror is backed by the
  // account's metadata, and the app-open guard costs at most a duplicate
  // the upsert collapses. The onboarding flag is re-marked, not removed: a
  // guest carrying on is not sent through the wizard again, and the next
  // account's own answer resets it at sign-in. Device settings stay: the
  // language (limecore_lang), the F-Droid update check, the sync toggle,
  // programs and exercises.
  step(releaseOnboardingOnSignOut());
  step(forgetReferralAskedLocally());
  step(forgetLastAppOpen());
  return ok;
}
